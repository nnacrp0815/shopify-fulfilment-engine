import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { rulesSchema } from "./model.js";
import { Store } from "./store.js";
import { createApp } from "./server.js";
import { startWorker } from "./worker.js";

const mode = process.env.MODE ?? "demo";
if (mode !== "demo" && mode !== "service")
  throw new Error("MODE must be demo or service");
const host = process.env.HOST ?? "127.0.0.1";
if (mode === "demo" && !["127.0.0.1", "::1"].includes(host))
  throw new Error("Demo must bind to loopback");
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
const rules = rulesSchema.parse(
  JSON.parse(
    readFileSync(process.env.RULES_PATH ?? "config/rules.example.json", "utf8"),
  ),
);
const secret =
  mode === "demo"
    ? randomBytes(32).toString("hex")
    : process.env.SHOPIFY_WEBHOOK_SECRET;
if (!secret)
  throw new Error("SHOPIFY_WEBHOOK_SECRET is required in service mode");
const shop =
  mode === "demo" ? "portfolio-demo.myshopify.com" : process.env.SHOPIFY_SHOP;
if (!shop) throw new Error("SHOPIFY_SHOP is required");
const store = new Store(process.env.DB_PATH ?? "data/engine.sqlite");
const server = createApp({
  mode,
  shop,
  secrets: [
    secret,
    ...(process.env.SHOPIFY_PREVIOUS_WEBHOOK_SECRET
      ? [process.env.SHOPIFY_PREVIOUS_WEBHOOK_SECRET]
      : []),
  ],
  adminToken: process.env.ADMIN_TOKEN ?? "",
  rules,
  store,
});
server.requestTimeout = 5000;
server.headersTimeout = 5000;
server.keepAliveTimeout = 5000;
const stopWorker = startWorker(store, rules);
server.listen(port, host, () =>
  console.log(
    JSON.stringify({ event: "listening", mode, url: `http://${host}:${port}` }),
  ),
);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await stopWorker();
    store.close();
  });
  server.closeIdleConnections();
}
process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
