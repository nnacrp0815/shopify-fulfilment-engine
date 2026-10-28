import { readFileSync } from "node:fs";
import { rulesSchema, normalizeOrder } from "../src/model.js";
import { fixture } from "../src/demo-data.js";
import { digest, type Intake } from "../src/store.js";
export const rules = () =>
  rulesSchema.parse(
    JSON.parse(readFileSync("config/rules.example.json", "utf8")),
  );
export const order = (patch: Record<string, unknown> = {}) =>
  normalizeOrder({ ...fixture(), ...patch });
export const intake = (patch: Partial<Intake> = {}): Intake => ({
  shop: "portfolio-demo.myshopify.com",
  topic: "orders/updated",
  deliveryId: "delivery-1",
  eventId: "event-1",
  order: order(),
  bodyHash: digest(order()),
  ...patch,
});
export const now = Date.parse("2026-10-28T03:00:00Z");
