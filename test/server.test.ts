import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, type AppOptions } from "../src/server.js";
import { Store } from "../src/store.js";
import { sign, verify } from "../src/security.js";
import { fixture } from "../src/demo-data.js";
import { rules } from "./helpers.js";

async function withServer(
  run: (url: string, options: AppOptions) => Promise<void>,
  patch: Partial<AppOptions> = {},
) {
  const store = new Store();
  const options: AppOptions = {
    store,
    rules: rules(),
    shop: "portfolio-demo.myshopify.com",
    secrets: ["test-only-signing-key"],
    mode: "demo",
    adminToken: "a".repeat(32),
    ...patch,
  };
  const server = createApp(options);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`, options);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
}
function headers(options: AppOptions, body: string) {
  return {
    "content-type": "application/json",
    "x-shopify-shop-domain": options.shop,
    "x-shopify-topic": "orders/paid",
    "x-shopify-webhook-id": "test-delivery",
    "x-shopify-event-id": "test-event",
    "x-shopify-hmac-sha256": sign(body, options.secrets[0]!),
  };
}

test("signed raw body accepted, deduplicated and acknowledged before worker runs", async () =>
  withServer(async (url, options) => {
    const body = JSON.stringify(fixture(), null, 2);
    const request = { method: "POST", body, headers: headers(options, body) };
    assert.equal((await fetch(`${url}/webhooks/orders`, request)).status, 202);
    assert.equal(options.store.snapshot().orders.length, 0);
    assert.equal((await fetch(`${url}/webhooks/orders`, request)).status, 200);
    assert.equal(options.store.snapshot().deliveries.length, 1);
  }));
test("tampered, missing and malformed signatures reject without persistence", async () =>
  withServer(async (url, options) => {
    const body = JSON.stringify(fixture());
    for (const signature of [
      "",
      "bad",
      sign(body + " ", options.secrets[0]!),
    ]) {
      const h = {
        ...headers(options, body),
        "x-shopify-hmac-sha256": signature,
      };
      assert.equal(
        (
          await fetch(`${url}/webhooks/orders`, {
            method: "POST",
            body,
            headers: h,
          })
        ).status,
        401,
      );
    }
    assert.equal(options.store.snapshot().deliveries.length, 0);
  }));
test("secret rotation accepts old and new; raw bytes are significant", () => {
  const body = Buffer.from('{"hello":"world"}');
  assert.equal(verify(body, sign(body, "old"), ["new", "old"]), true);
  assert.equal(verify(body, sign(body, "new"), ["new", "old"]), true);
  assert.equal(
    verify(Buffer.from('{ "hello":"world"}'), sign(body, "old"), ["old"]),
    false,
  );
});
test("authenticated wrong shops, topics, metadata and invalid payloads reject", async () =>
  withServer(async (url, options) => {
    const body = JSON.stringify(fixture());
    for (const [patch, status] of [
      [{ "x-shopify-shop-domain": "other.myshopify.com" }, 403],
      [{ "x-shopify-topic": "products/create" }, 400],
      [{ "x-shopify-webhook-id": "" }, 400],
    ] as const) {
      assert.equal(
        (
          await fetch(`${url}/webhooks/orders`, {
            method: "POST",
            body,
            headers: { ...headers(options, body), ...patch },
          })
        ).status,
        status,
      );
    }
    const invalid = "{bad json";
    assert.equal(
      (
        await fetch(`${url}/webhooks/orders`, {
          method: "POST",
          body: invalid,
          headers: headers(options, invalid),
        })
      ).status,
      422,
    );
  }));
test("body limits and content type enforced", async () =>
  withServer(
    async (url, options) => {
      const body = JSON.stringify(fixture());
      assert.equal(
        (
          await fetch(`${url}/webhooks/orders`, {
            method: "POST",
            body,
            headers: headers(options, body),
          })
        ).status,
        413,
      );
      assert.equal(
        (
          await fetch(`${url}/webhooks/orders`, {
            method: "POST",
            body,
            headers: {
              ...headers(options, body),
              "content-type": "text/plain",
            },
          })
        ).status,
        415,
      );
    },
    { maxBodyBytes: 10 },
  ));
test("reused delivery ID with changed signed payload returns conflict", async () =>
  withServer(async (url, options) => {
    for (const [price, status] of [
      ["85.00", 202],
      ["86.00", 409],
    ] as const) {
      const body = JSON.stringify({
        ...fixture(),
        current_subtotal_price: price,
      });
      assert.equal(
        (
          await fetch(`${url}/webhooks/orders`, {
            method: "POST",
            body,
            headers: headers(options, body),
          })
        ).status,
        status,
      );
    }
  }));
test("service API requires bearer token and disables demo writes", async () =>
  withServer(
    async (url, options) => {
      assert.equal((await fetch(`${url}/api/state`)).status, 401);
      assert.equal(
        (await fetch(`${url}/api/state?token=${options.adminToken}`)).status,
        401,
      );
      const auth = { authorization: `Bearer ${options.adminToken}` };
      assert.equal(
        (await fetch(`${url}/api/state`, { headers: auth })).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${url}/api/demo/pickup`, {
            method: "POST",
            headers: auth,
          })
        ).status,
        404,
      );
    },
    { mode: "service" },
  ));
test("health and viewer assets respond with security headers; arbitrary paths do not", async () =>
  withServer(async (url) => {
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    for (const path of [
      "/",
      "/index.html",
      "/app.js",
      "/preview.js",
      "/style.css",
    ]) {
      const response = await fetch(url + path);
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-security-policy")!,
        /frame-ancestors 'none'/,
      );
    }
    assert.equal((await fetch(`${url}/unknown`)).status, 404);
  }));
test("demo endpoints enqueue fictional scenarios and reject unknown scenarios", async () =>
  withServer(async (url, options) => {
    assert.equal(
      (await fetch(`${url}/api/demo/pickup`, { method: "POST" })).status,
      202,
    );
    assert.equal(options.store.snapshot().deliveries.length, 1);
    assert.equal(
      (await fetch(`${url}/api/demo/missing`, { method: "POST" })).status,
      404,
    );
  }));
test("storage failure returns retryable 503 without exposing exception details", async () =>
  withServer(async (url, options) => {
    options.store.db.exec("DROP TABLE deliveries");
    const body = JSON.stringify(fixture());
    const response = await fetch(`${url}/webhooks/orders`, {
      method: "POST",
      body,
      headers: headers(options, body),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "TEMPORARILY_UNAVAILABLE",
    });
  }));
test("configuration fails closed without shop, secrets or service token", () => {
  const store = new Store();
  const base: AppOptions = {
    store,
    rules: rules(),
    mode: "service",
    shop: "test.myshopify.com",
    secrets: ["secret"],
    adminToken: "a".repeat(32),
  };
  try {
    for (const patch of [
      { shop: "evil.test" },
      { secrets: [] },
      { adminToken: "" },
    ])
      assert.throws(() => createApp({ ...base, ...patch }));
  } finally {
    store.close();
  }
});
