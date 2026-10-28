import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { routeOrder } from "../src/engine.js";
import type { Order, Rules, Decision } from "../src/model.js";

type Preview = {
  rules: Rules;
  createScenario: (name: string, now: Date) => Order;
  routeOrder: (order: Order, rules: Rules, now: Date) => Decision;
};
function loadPreview(): Preview {
  const window: { FulfilmentPreview?: Preview } = {};
  runInNewContext(readFileSync("public/preview.js", "utf8"), { window });
  return window.FulfilmentPreview!;
}
test("standalone preview runs the shared routing rules without modules, network or Node APIs", () => {
  const preview = loadPreview();
  const now = new Date("2026-10-28T03:00:00Z");
  const statuses = [
    "split-shipping",
    "pickup",
    "unknown-sku",
    "unpaid",
    "digital",
    "cancelled",
  ].map((name) => {
    const order = preview.createScenario(name, now);
    const result = preview.routeOrder(order, preview.rules, now);
    assert.equal(
      JSON.stringify(result),
      JSON.stringify(routeOrder(order, preview.rules, now)),
    );
    return result.status;
  });
  assert.deepEqual(statuses, [
    "routed",
    "routed",
    "held",
    "held",
    "routed",
    "ignored",
  ]);
  assert.throws(() => preview.createScenario("unknown", now));
});
test("preview pickup dates remain valid after the original fixture date", () => {
  const preview = loadPreview();
  const now = new Date("2031-07-20T20:00:00Z");
  const pickup = preview.createScenario("pickup", now);
  assert.equal(pickup.pickupDate, "2031-07-22");
  assert.equal(preview.routeOrder(pickup, preview.rules, now).status, "routed");
});
test("HTML asset references work from a directory and from a direct file preview", () => {
  const html = readFileSync("public/index.html", "utf8");
  for (const asset of ["style.css", "preview.js", "app.js"]) {
    assert.ok(html.includes(`"./${asset}"`));
    assert.doesNotThrow(() => readFileSync(`public/${asset}`));
  }
});

test("portable client demo contains its styles and scripts without external asset requests", () => {
  const html = readFileSync("demo.html", "utf8");
  assert.ok(html.includes("<style>"));
  assert.ok(html.includes("window.FulfilmentPreview"));
  assert.ok(html.includes("Your orders, under control."));
  assert.equal(/<script[^>]+src=/.test(html), false);
  assert.equal(/<link[^>]+rel="stylesheet"/.test(html), false);
  assert.equal(html.includes('href="./index.html"'), false);
});
