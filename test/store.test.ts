import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, digest } from "../src/store.js";
import { routeOrder } from "../src/engine.js";
import { processOne } from "../src/worker.js";
import { intake, order, rules, now } from "./helpers.js";

test("intake deduplicates matching deliveries and rejects payload collisions", () => {
  const store = new Store();
  try {
    assert.equal(store.enqueue(intake(), now), "accepted");
    assert.equal(store.enqueue(intake(), now), "duplicate");
    assert.equal(
      store.enqueue(intake({ bodyHash: "different" }), now),
      "conflict",
    );
    assert.equal(store.snapshot().deliveries.length, 1);
  } finally {
    store.close();
  }
});
test("decisions and proposed tasks commit atomically; completed payload is removed", async () => {
  const store = new Store();
  try {
    store.enqueue(intake(), now);
    await processOne(store, rules(), { now });
    assert.equal(store.snapshot().orders.length, 1);
    assert.equal(store.snapshot().outbox.length, 2);
    assert.equal(
      store.db.prepare("SELECT order_json FROM deliveries").get()?.order_json,
      null,
    );
    assert.equal(store.snapshot().deliveries[0]?.state, "done");
  } finally {
    store.close();
  }
});
test("different delivery IDs for an unchanged order produce no duplicate tasks", async () => {
  const store = new Store();
  try {
    store.enqueue(intake(), now);
    await processOne(store, rules(), { now });
    store.enqueue(intake({ deliveryId: "other" }), now + 1);
    await processOne(store, rules(), { now: now + 1 });
    assert.equal(store.snapshot().outbox.length, 2);
    assert.ok(
      store.snapshot().deliveries.some((d) => d.outcome === "unchanged"),
    );
  } finally {
    store.close();
  }
});
test("older updates cannot overwrite a cancellation or resurrect proposed work", async () => {
  const store = new Store();
  try {
    store.enqueue(intake(), now);
    await processOne(store, rules(), { now });
    const cancelled = order({
      updated_at: "2026-10-28T02:01:00Z",
      cancelled_at: "2026-10-28T02:01:00Z",
    });
    store.enqueue(
      intake({
        deliveryId: "cancel",
        order: cancelled,
        bodyHash: digest(cancelled),
      }),
      now + 1,
    );
    await processOne(store, rules(), { now: now + 1 });
    store.enqueue(intake({ deliveryId: "late" }), now + 2);
    await processOne(store, rules(), { now: now + 2 });
    assert.ok(store.snapshot().outbox.every((t) => t.state === "superseded"));
    assert.ok(store.snapshot().deliveries.some((d) => d.outcome === "stale"));
  } finally {
    store.close();
  }
});
test("equal timestamp conflicts hold and supersede all earlier tasks", async () => {
  const store = new Store();
  try {
    store.enqueue(intake(), now);
    await processOne(store, rules(), { now });
    const changed = order({ financial_status: "pending" });
    store.enqueue(
      intake({
        deliveryId: "conflict",
        order: changed,
        bodyHash: digest(changed),
      }),
      now + 1,
    );
    await processOne(store, rules(), { now: now + 1 });
    assert.ok(store.snapshot().outbox.every((t) => t.state === "superseded"));
    assert.deepEqual(
      (store.snapshot().orders[0]?.decision as { reasons: string[] }).reasons,
      ["CONFLICTING_ORDER_SNAPSHOT"],
    );
  } finally {
    store.close();
  }
});
test("failed attempt retries with backoff then dead-letters and supports explicit replay", async () => {
  const store = new Store();
  try {
    store.enqueue(intake(), now);
    const evaluate = () => {
      throw new Error("sensitive token must not be persisted");
    };
    await processOne(store, rules(), { now, maxAttempts: 2, evaluate });
    assert.equal(store.claim(now + 999), undefined);
    await processOne(store, rules(), {
      now: now + 1000,
      maxAttempts: 2,
      evaluate,
    });
    const job = store.snapshot().deliveries[0]!;
    assert.equal(job.state, "dead");
    assert.ok(!JSON.stringify(job).includes("sensitive"));
    assert.equal(store.retryDead(String(job.key), now + 2000), true);
    await processOne(store, rules(), { now: now + 2000 });
    assert.equal(store.snapshot().deliveries[0]?.state, "done");
  } finally {
    store.close();
  }
});
test("expired lease is recovered; an old worker is fenced from committing", () => {
  const store = new Store();
  try {
    store.enqueue(intake(), now);
    const old = store.claim(now, 100)!;
    assert.equal(store.claim(now + 50), undefined);
    const fresh = store.claim(now + 101)!;
    assert.equal(
      store.complete(old, routeOrder(old.order, rules()), rules(), now + 102),
      false,
    );
    assert.equal(
      store.complete(
        fresh,
        routeOrder(fresh.order, rules()),
        rules(),
        now + 102,
      ),
      true,
    );
    assert.equal(store.snapshot().outbox.length, 2);
  } finally {
    store.close();
  }
});
test("last-attempt crashes become dead letters rather than disappearing", () => {
  const store = new Store();
  try {
    store.enqueue(intake(), now);
    store.claim(now, 100, 1);
    assert.equal(store.claim(now + 101, 100, 1), undefined);
    assert.equal(store.snapshot().deliveries[0]?.state, "dead");
  } finally {
    store.close();
  }
});
test("durable inbox survives closing and reopening a file database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-test-"));
  const path = join(dir, "queue.sqlite");
  try {
    let store = new Store(path);
    store.enqueue(intake(), now);
    store.close();
    store = new Store(path);
    await processOne(store, rules(), { now });
    assert.equal(store.snapshot().orders.length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("two SQLite connections cannot claim the same unexpired job", () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-test-"));
  const path = join(dir, "queue.sqlite");
  const first = new Store(path),
    second = new Store(path);
  try {
    first.enqueue(intake(), now);
    assert.ok(first.claim(now));
    assert.equal(second.claim(now), undefined);
  } finally {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("transaction rollback leaves job recoverable and no partial order or outbox", async () => {
  const store = new Store();
  try {
    store.enqueue(intake(), now);
    store.db.exec(
      "CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'test failure'); END",
    );
    await processOne(store, rules(), { now });
    assert.equal(store.snapshot().orders.length, 0);
    assert.equal(store.snapshot().outbox.length, 0);
    assert.equal(store.snapshot().deliveries[0]?.state, "queued");
    store.db.exec("DROP TRIGGER fail_outbox");
    await processOne(store, rules(), { now: now + 1000 });
    assert.equal(store.snapshot().orders.length, 1);
  } finally {
    store.close();
  }
});
