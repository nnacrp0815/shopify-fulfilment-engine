import { Store } from "./store.js";
const key = process.argv[2];
if (!key)
  throw new Error(
    "Usage: node --env-file-if-exists=.env dist/src/retry.js DELIVERY_KEY",
  );
const store = new Store(process.env.DB_PATH ?? "data/engine.sqlite");
try {
  if (!store.retryDead(key)) throw new Error("Dead-letter job not found");
  console.log("Job queued for retry.");
} finally {
  store.close();
}
