import { test } from "node:test";
import assert from "node:assert/strict";
import { routeOrder } from "../src/engine.js";
import { normalizeOrder, rulesSchema } from "../src/model.js";
import { fixture, scenario } from "../src/demo-data.js";
import { order, rules, now } from "./helpers.js";

test("splits an order deterministically across eligible warehouses", () => {
  const result = routeOrder(order(), rules(), new Date(now));
  assert.equal(result.status, "routed");
  assert.ok(result.reasons.includes("SPLIT_SHIPMENT"));
  assert.deepEqual(
    result.tasks.map((t) => t.destination),
    ["west-3pl", "studio"],
  );
});
for (const [name, patch, reason] of [
  ["unpaid", { financial_status: "pending" }, "PAYMENT_NOT_PAID"],
  ["refunded", { financial_status: "refunded" }, "PAYMENT_NOT_PAID"],
  ["wrong currency", { currency: "USD" }, "CURRENCY_NOT_SUPPORTED"],
  ["minimum", { current_subtotal_price: "29.99" }, "BELOW_MINIMUM_SUBTOTAL"],
  ["no destination", { shipping_address: null }, "DESTINATION_NOT_SUPPORTED"],
  [
    "unsupported country",
    { shipping_address: { country_code: "NZ" } },
    "DESTINATION_NOT_SUPPORTED",
  ],
] as const)
  test(`holds ${name} without partial tasks`, () => {
    const result = routeOrder(order(patch), rules(), new Date(now));
    assert.equal(result.status, "held");
    assert.ok(result.reasons.includes(reason));
    assert.deepEqual(result.tasks, []);
  });
test("minimum uses exact decimal cents and accepts boundary", () => {
  assert.equal(order({ current_subtotal_price: "30.01" }).subtotalCents, 3001);
  assert.equal(
    routeOrder(order({ current_subtotal_price: "30.00" }), rules()).status,
    "routed",
  );
});
test("cancelled and already fulfilled orders cannot create tasks", () => {
  for (const patch of [
    { cancelled_at: "2026-10-28T01:00:00Z" },
    { fulfillment_status: "fulfilled" },
  ])
    assert.equal(routeOrder(order(patch), rules()).status, "ignored");
});
test("unknown SKUs and shipping flag mismatches fail closed", () => {
  const unknown = normalizeOrder(scenario("unknown-sku", new Date(now)));
  assert.equal(routeOrder(unknown, rules()).status, "held");
  const digital = normalizeOrder(scenario("digital", new Date(now)));
  digital.lines[0]!.requiresShipping = true;
  assert.ok(
    routeOrder(digital, rules()).reasons.includes(
      "SHIPPING_FLAG_MISMATCH:GUIDE-PDF",
    ),
  );
});
test("valid pickup plans at its nominated location; invalid dates and locations hold", () => {
  const pickup = normalizeOrder(scenario("pickup", new Date(now)));
  assert.equal(
    routeOrder(pickup, rules(), new Date(now)).tasks[0]?.type,
    "prepare-pickup",
  );
  for (const date of ["2026-02-30", "2026-10-27", "bad", null])
    assert.equal(
      routeOrder({ ...pickup, pickupDate: date }, rules(), new Date(now))
        .status,
      "held",
    );
  assert.ok(
    routeOrder(
      { ...pickup, pickupLocation: "elsewhere" },
      rules(),
      new Date(now),
    ).reasons.includes("INVALID_PICKUP_LOCATION"),
  );
});
test("pickup date uses configured local day across UTC midnight", () => {
  const pickup = normalizeOrder(scenario("pickup", new Date(now)));
  pickup.pickupDate = "2026-10-28";
  assert.equal(
    routeOrder(pickup, rules(), new Date("2026-10-28T16:01:00Z")).status,
    "held",
  );
});
test("pickup-only cannot ship and digital needs no address or inventory", () => {
  const pickup = normalizeOrder(scenario("pickup", new Date(now)));
  pickup.method = "shipping";
  assert.ok(
    routeOrder(pickup, rules()).reasons.includes("PICKUP_ITEM_CANNOT_SHIP"),
  );
  const digital = normalizeOrder(scenario("digital", new Date(now)));
  digital.country = null;
  assert.equal(routeOrder(digital, rules()).tasks[0]?.type, "digital-delivery");
});
test("repeated SKU lines share stock and insufficient stock yields no tasks", () => {
  const input = order();
  input.lines = [
    { id: "1", sku: "TEE-BLACK", quantity: 30, requiresShipping: true },
    { id: "2", sku: "TEE-BLACK", quantity: 30, requiresShipping: true },
  ];
  assert.deepEqual(routeOrder(input, rules()).tasks, []);
  assert.ok(routeOrder(input, rules()).reasons.includes("INSUFFICIENT_STOCK"));
});
test("disabling split shipping holds mixed location carts", () => {
  const config = rules();
  config.allowSplitShipping = false;
  assert.equal(routeOrder(order(), config).status, "held");
});
test("unit limit holds; zero remaining quantity ignores", () => {
  const config = rules();
  config.maxOrderUnits = 1;
  assert.ok(routeOrder(order(), config).reasons.includes("ORDER_UNIT_LIMIT"));
  const input = order();
  input.lines.forEach((l) => {
    l.quantity = 0;
  });
  assert.equal(routeOrder(input, config).status, "ignored");
});
test("normalizer strips customer PII and unrelated attributes", () => {
  const normalized = normalizeOrder({
    ...fixture(),
    email: "private@example.test",
    customer: { first_name: "Private" },
    note_attributes: [{ name: "customer_email", value: "secret@example.test" }],
  });
  assert.ok(!JSON.stringify(normalized).includes("private"));
  assert.ok(!JSON.stringify(normalized).includes("secret"));
});
test("invalid payloads, unsafe IDs, duplicate lines and attributes reject", () => {
  for (const patch of [
    { id: 9007199254740992 },
    { current_subtotal_price: "12.345" },
    { updated_at: "yesterday" },
    {
      line_items: [
        {
          id: 1,
          sku: "TEE-BLACK",
          quantity: 1,
          fulfillable_quantity: 2,
          requires_shipping: true,
        },
      ],
    },
  ])
    assert.throws(() => order(patch));
  const raw = fixture();
  const lines = raw.line_items as unknown[];
  raw.line_items = [lines[0], lines[0]];
  assert.throws(() => normalizeOrder(raw));
  assert.throws(() =>
    order({
      note_attributes: [
        { name: "delivery_method", value: "pickup" },
        { name: "delivery_method", value: "shipping" },
      ],
    }),
  );
});
test("configuration rejects invalid timezone, warehouse references and unknown stock SKUs", () => {
  for (const patch of [
    { timezone: "Invalid/Zone" },
    { pickupLocations: ["missing"] },
    {
      warehouses: [
        { id: "a", priority: 1, countries: ["AU"], stock: { UNKNOWN: 2 } },
      ],
    },
  ])
    assert.equal(
      rulesSchema.safeParse({ ...rules(), ...patch }).success,
      false,
    );
});
test("routing conserves every unit over a deterministic range of split allocations", () => {
  for (let qty = 1; qty <= 60; qty++) {
    const input = order();
    input.lines = [
      { id: "1", sku: "TEE-BLACK", quantity: qty, requiresShipping: true },
    ];
    const config = rules();
    config.warehouses[1]!.stock["TEE-BLACK"] = 15;
    const result = routeOrder(input, config);
    assert.equal(result.status, "routed");
    assert.equal(
      result.tasks.flatMap((t) => t.lines).reduce((n, l) => n + l.quantity, 0),
      qty,
    );
    assert.ok(result.tasks.every((t) => t.lines.every((l) => l.quantity > 0)));
  }
});
