import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Decision, Order, Rules } from "./model.js";

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export type Intake = {
  shop: string;
  topic: string;
  deliveryId: string;
  eventId: string;
  bodyHash: string;
  order: Order;
};
export type Job = {
  key: string;
  owner: string;
  shop: string;
  topic: string;
  order: Order;
  attempts: number;
};
type Row = Record<string, unknown>;

export class Store {
  readonly db: DatabaseSync;
  constructor(path = ":memory:") {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS deliveries (
        key TEXT PRIMARY KEY, shop TEXT NOT NULL, topic TEXT NOT NULL, delivery_id TEXT NOT NULL,
        event_id TEXT NOT NULL, body_hash TEXT NOT NULL, order_json TEXT,
        state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL, lease_until INTEGER, owner TEXT, error_code TEXT,
        outcome TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS deliveries_queue ON deliveries(state, available_at, lease_until);
      CREATE TABLE IF NOT EXISTS orders (
        key TEXT PRIMARY KEY, shop TEXT NOT NULL, order_id TEXT NOT NULL, updated_at TEXT NOT NULL,
        order_hash TEXT NOT NULL, rules_hash TEXT NOT NULL, decision_json TEXT NOT NULL, decided_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, order_key TEXT NOT NULL, task_json TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );`);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  enqueue(
    input: Intake,
    now = Date.now(),
  ): "accepted" | "duplicate" | "conflict" {
    return this.transaction(() => {
      const key = JSON.stringify([input.shop, input.topic, input.deliveryId]);
      const previous = this.db
        .prepare("SELECT body_hash FROM deliveries WHERE key=?")
        .get(key);
      if (previous)
        return previous.body_hash === input.bodyHash ? "duplicate" : "conflict";
      this.db
        .prepare(
          `INSERT INTO deliveries(key,shop,topic,delivery_id,event_id,body_hash,order_json,available_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          key,
          input.shop,
          input.topic,
          input.deliveryId,
          input.eventId,
          input.bodyHash,
          JSON.stringify(input.order),
          now,
          now,
        );
      return "accepted";
    });
  }
  claim(now = Date.now(), leaseMs = 30000, maxAttempts = 5): Job | undefined {
    return this.transaction(() => {
      this.db
        .prepare(
          "UPDATE deliveries SET state='dead',error_code='LEASE_EXHAUSTED',owner=NULL WHERE state='processing' AND lease_until<=? AND attempts>=?",
        )
        .run(now, maxAttempts);
      const row = this.db
        .prepare(
          `SELECT * FROM deliveries WHERE attempts<? AND ((state='queued' AND available_at<=?) OR (state='processing' AND lease_until<=?)) ORDER BY created_at,key LIMIT 1`,
        )
        .get(maxAttempts, now, now);
      if (!row) return undefined;
      const owner = randomUUID();
      this.db
        .prepare(
          "UPDATE deliveries SET state='processing',attempts=attempts+1,owner=?,lease_until=? WHERE key=?",
        )
        .run(owner, now + leaseMs, String(row.key));
      return {
        key: String(row.key),
        owner,
        shop: String(row.shop),
        topic: String(row.topic),
        order: JSON.parse(String(row.order_json)) as Order,
        attempts: Number(row.attempts) + 1,
      };
    });
  }
  complete(
    job: Job,
    decision: Decision,
    rules: Rules,
    now = Date.now(),
  ): boolean {
    return this.transaction(() => {
      const owned = this.db
        .prepare(
          "SELECT key FROM deliveries WHERE key=? AND owner=? AND state='processing' AND lease_until>?",
        )
        .get(job.key, job.owner, now);
      if (!owned) return false;
      const orderKey = JSON.stringify([job.shop, job.order.id]);
      const hash = digest(job.order);
      const existing = this.db
        .prepare("SELECT * FROM orders WHERE key=?")
        .get(orderKey);
      let outcome = "decided";
      if (existing && String(existing.updated_at) > job.order.updatedAt)
        outcome = "stale";
      else if (
        existing &&
        String(existing.updated_at) === job.order.updatedAt &&
        existing.order_hash === hash
      )
        outcome = "unchanged";
      else {
        // Equal timestamps with different snapshots are ambiguous: invalidate all proposals.
        if (existing && String(existing.updated_at) === job.order.updatedAt) {
          decision = {
            status: "held",
            reasons: ["CONFLICTING_ORDER_SNAPSHOT"],
            tasks: [],
            rulesVersion: rules.version,
          };
          outcome = "snapshot-conflict";
        }
        this.db
          .prepare(
            "UPDATE outbox SET state='superseded' WHERE order_key=? AND state='proposed'",
          )
          .run(orderKey);
        this.db
          .prepare(
            `INSERT INTO orders VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET updated_at=excluded.updated_at,order_hash=excluded.order_hash,rules_hash=excluded.rules_hash,decision_json=excluded.decision_json,decided_at=excluded.decided_at`,
          )
          .run(
            orderKey,
            job.shop,
            job.order.id,
            job.order.updatedAt,
            hash,
            digest(rules),
            JSON.stringify(decision),
            now,
          );
        for (const [index, task] of decision.tasks.entries()) {
          const id = digest([orderKey, hash, digest(rules), index]);
          this.db
            .prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,'proposed',?)")
            .run(id, orderKey, JSON.stringify(task), now);
        }
      }
      this.db
        .prepare(
          "UPDATE deliveries SET state='done',outcome=?,order_json=NULL,owner=NULL,lease_until=NULL,error_code=NULL WHERE key=?",
        )
        .run(outcome, job.key);
      return true;
    });
  }
  fail(job: Job, now = Date.now(), maxAttempts = 5): void {
    this.db
      .prepare(
        "UPDATE deliveries SET state=?,available_at=?,owner=NULL,lease_until=NULL,error_code='PROCESSING_FAILED' WHERE key=? AND owner=? AND state='processing'",
      )
      .run(
        job.attempts >= maxAttempts ? "dead" : "queued",
        now + Math.min(60000, 1000 * 2 ** (job.attempts - 1)),
        job.key,
        job.owner,
      );
  }
  retryDead(key: string, now = Date.now()): boolean {
    return (
      this.db
        .prepare(
          "UPDATE deliveries SET state='queued',attempts=0,available_at=?,error_code=NULL WHERE key=? AND state='dead'",
        )
        .run(now, key).changes === 1
    );
  }
  snapshot(): { deliveries: Row[]; orders: Row[]; outbox: Row[] } {
    return {
      deliveries: this.db
        .prepare(
          "SELECT key,shop,topic,delivery_id,event_id,state,attempts,error_code,outcome,created_at FROM deliveries ORDER BY created_at DESC LIMIT 100",
        )
        .all(),
      orders: this.db
        .prepare(
          "SELECT shop,order_id,updated_at,rules_hash,decision_json FROM orders ORDER BY decided_at DESC LIMIT 100",
        )
        .all()
        .map(({ decision_json, ...row }) => ({
          ...row,
          decision: JSON.parse(String(decision_json)) as Decision,
        })),
      outbox: this.db
        .prepare(
          "SELECT id,order_key,task_json,state FROM outbox ORDER BY created_at DESC LIMIT 200",
        )
        .all()
        .map(({ task_json, ...row }) => ({
          ...row,
          task: JSON.parse(String(task_json)),
        })),
    };
  }
  healthy(): boolean {
    return this.db.prepare("SELECT 1 AS healthy").get()?.healthy === 1;
  }
  close(): void {
    this.db.close();
  }
}
