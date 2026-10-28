import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../src/store.js";
import { startWorker } from "../src/worker.js";
import { intake, rules } from "./helpers.js";

test("background worker processes durable work and stops without another claim", async () => {
  const store = new Store();
  store.enqueue(intake());
  const stop = startWorker(store, rules(), 5);
  try {
    for (let count = 0; count < 100 && !store.snapshot().orders.length; count++)
      await delay(5);
    assert.equal(store.snapshot().orders.length, 1);
    await stop();
    store.enqueue(intake({ deliveryId: "after-stop" }));
    await delay(15);
    assert.equal(
      store.snapshot().deliveries.find((d) => d.delivery_id === "after-stop")
        ?.state,
      "queued",
    );
  } finally {
    await stop();
    store.close();
  }
});
