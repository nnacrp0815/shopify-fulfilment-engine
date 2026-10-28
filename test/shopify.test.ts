import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ShopifyReader,
  buildMoveProposal,
  type FulfilmentSnapshot,
  READ_FULFILMENT_ORDER,
} from "../src/shopify.js";
const snapshot = (): FulfilmentSnapshot => ({
  id: "gid://shopify/FulfillmentOrder/1",
  status: "OPEN",
  requestStatus: "UNSUBMITTED",
  assignedLocation: { location: { id: "gid://shopify/Location/1" } },
  lineItems: {
    nodes: [
      {
        id: "gid://shopify/FulfillmentOrderLineItem/1",
        remainingQuantity: 2,
        lineItem: { id: "gid://shopify/LineItem/1", sku: "TEE-BLACK" },
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
});
const line = { id: "gid://shopify/FulfillmentOrderLineItem/1", quantity: 1 };
const noSleep = async () => {};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
test("Shopify reader sends versioned query and credentials only to allowlisted shop origin", async () => {
  const transport: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, "error");
    assert.equal(
      input,
      "https://test.myshopify.com/admin/api/2026-10/graphql.json",
    );
    assert.equal(
      (init?.headers as Record<string, string>)["x-shopify-access-token"],
      "test-token",
    );
    assert.equal(JSON.parse(String(init?.body)).query, READ_FULFILMENT_ORDER);
    return response({ data: { fulfillmentOrder: snapshot() } });
  };
  assert.deepEqual(
    await new ShopifyReader(
      "test.myshopify.com",
      "test-token",
      transport,
    ).readFulfilmentOrder(snapshot().id),
    snapshot(),
  );
  assert.throws(
    () => new ShopifyReader("test.myshopify.com.evil.test", "token"),
  );
});
test("reader retries throttled HTTP and GraphQL reads, never silently accepts partial errors", async () => {
  let calls = 0;
  const transport: typeof fetch = async () => {
    calls++;
    if (calls === 1) return response({}, 429);
    if (calls === 2)
      return response({ errors: [{ extensions: { code: "THROTTLED" } }] });
    return response({ data: { fulfillmentOrder: snapshot() } });
  };
  await new ShopifyReader(
    "test.myshopify.com",
    "test-token",
    transport,
    noSleep,
  ).readFulfilmentOrder(snapshot().id);
  assert.equal(calls, 3);
  await assert.rejects(
    new ShopifyReader(
      "test.myshopify.com",
      "test-token",
      async () =>
        response({ data: { fulfillmentOrder: snapshot() }, errors: [{}] }),
      noSleep,
    ).readFulfilmentOrder(snapshot().id),
    /GRAPHQL_ERROR/,
  );
});
test("reader rejects exhausted retries, permanent HTTP errors, missing data and truncated pagination", async () => {
  for (const [make, pattern] of [
    [() => response({}, 500), /RETRIES_EXHAUSTED/],
    [() => response({}, 401), /HTTP_ERROR/],
    [() => response({ data: { fulfillmentOrder: null } }), /NOT_FOUND/],
    [
      () =>
        response({
          data: {
            fulfillmentOrder: {
              ...snapshot(),
              lineItems: {
                ...snapshot().lineItems,
                pageInfo: { hasNextPage: true, endCursor: "x" },
              },
            },
          },
        }),
      /PAGINATION_REQUIRED/,
    ],
    [() => response({ unexpected: true }), /NOT_FOUND/],
  ] as const)
    await assert.rejects(
      new ShopifyReader(
        "test.myshopify.com",
        "test-token",
        async () => make(),
        noSleep,
      ).readFulfilmentOrder(snapshot().id),
      pattern,
    );
});
test("network errors use bounded retries and safe error messages", async () => {
  let calls = 0;
  await assert.rejects(
    new ShopifyReader(
      "test.myshopify.com",
      "test-token",
      async () => {
        calls++;
        throw new Error("private secret");
      },
      noSleep,
    ).readFulfilmentOrder(snapshot().id),
    /SHOPIFY_NETWORK_ERROR/,
  );
  assert.equal(calls, 3);
});
test("move proposal requires fulfilment IDs, fresh remaining quantities and movable status", () => {
  const proposal = buildMoveProposal(snapshot(), "gid://shopify/Location/2", [
    line,
  ]);
  assert.equal(proposal.mode, "proposal");
  assert.deepEqual(proposal.variables.lines, [line]);
  for (const lines of [
    [],
    [line, line],
    [{ ...line, quantity: 3 }],
    [{ ...line, id: "gid://shopify/LineItem/1" }],
  ])
    assert.throws(() =>
      buildMoveProposal(snapshot(), "gid://shopify/Location/2", lines),
    );
  assert.throws(() =>
    buildMoveProposal(
      { ...snapshot(), requestStatus: "SUBMITTED" },
      "gid://shopify/Location/2",
      [line],
    ),
  );
  assert.throws(() =>
    buildMoveProposal(
      { ...snapshot(), status: "CLOSED" },
      "gid://shopify/Location/2",
      [line],
    ),
  );
});
