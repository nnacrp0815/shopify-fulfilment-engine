import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { rulesSchema } from "./model.js";
import { Store } from "./store.js";
import { createApp } from "./server.js";
import { scenario, scenarioNames } from "./demo-data.js";
import { sign } from "./security.js";
import { processOne } from "./worker.js";

const directory = mkdtempSync(join(tmpdir(), "fulfilment-demo-"));
const rules = rulesSchema.parse(
  JSON.parse(readFileSync("config/rules.example.json", "utf8")),
);
const store = new Store(join(directory, "demo.sqlite"));
const secret = randomBytes(32).toString("hex");
const shop = "portfolio-demo.myshopify.com";
const server = createApp({
  store,
  rules,
  shop,
  secrets: [secret],
  mode: "demo",
  adminToken: "",
});
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  let first: { body: string; headers: Record<string, string> } | undefined;
  for (const name of scenarioNames) {
    const body = JSON.stringify(scenario(name));
    const headers = {
      "content-type": "application/json",
      "x-shopify-shop-domain": shop,
      "x-shopify-topic": "orders/updated",
      "x-shopify-webhook-id": `demo-${name}`,
      "x-shopify-hmac-sha256": sign(body, secret),
    };
    first ??= { body, headers };
    assert.equal(
      (await fetch(`${url}/webhooks/orders`, { method: "POST", body, headers }))
        .status,
      202,
    );
  }
  assert.equal(
    (await fetch(`${url}/webhooks/orders`, { method: "POST", ...first! }))
      .status,
    200,
  );
  while (await processOne(store, rules)) {
    /* Drain the durable queue for a deterministic demo. */
  }
  const snapshot = store.snapshot();
  const statuses = snapshot.orders.map(
    (o) => (o.decision as { status: string }).status,
  );
  assert.equal(statuses.filter((s) => s === "routed").length, 3);
  assert.equal(statuses.filter((s) => s === "held").length, 2);
  assert.equal(statuses.filter((s) => s === "ignored").length, 1);
  assert.equal(snapshot.outbox.filter((o) => o.state === "proposed").length, 4);
  console.table(
    snapshot.orders.map((o) => ({
      order: o.order_id,
      ...(o.decision as object),
    })),
  );
  console.log(
    "PASS: 6 signed HTTP webhooks, duplicate suppressed, 3 routed / 2 held / 1 ignored, 4 proposed tasks. No store credentials or external API calls.",
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
