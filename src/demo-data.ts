import { readFileSync } from "node:fs";
export const scenarioNames = [
  "split-shipping",
  "pickup",
  "unknown-sku",
  "unpaid",
  "digital",
  "cancelled",
] as const;
export type Scenario = (typeof scenarioNames)[number];
export function fixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync("fixtures/orders/paid-shipping.json", "utf8"),
  ) as Record<string, unknown>;
}
export function scenario(
  name: Scenario,
  now = new Date(),
): Record<string, unknown> {
  const order = fixture();
  order.id = 1001 + scenarioNames.indexOf(name);
  order.updated_at = now.toISOString();
  if (name === "unknown-sku")
    order.line_items = [
      {
        id: 101,
        sku: "UNLISTED",
        quantity: 1,
        fulfillable_quantity: 1,
        requires_shipping: true,
      },
    ];
  if (name === "unpaid") order.financial_status = "pending";
  if (name === "cancelled") order.cancelled_at = now.toISOString();
  if (name === "digital")
    order.line_items = [
      {
        id: 101,
        sku: "GUIDE-PDF",
        quantity: 1,
        fulfillable_quantity: 1,
        requires_shipping: false,
      },
    ];
  if (name === "pickup") {
    order.line_items = [
      {
        id: 101,
        sku: "CLASS-01",
        quantity: 1,
        fulfillable_quantity: 1,
        requires_shipping: true,
      },
    ];
    const date = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);
    order.note_attributes = [
      { name: "delivery_method", value: "pickup" },
      { name: "pickup_date", value: date },
      { name: "pickup_location", value: "studio" },
    ];
  }
  return order;
}
