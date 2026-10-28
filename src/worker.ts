import { routeOrder } from "./engine.js";
import type { Decision, Order, Rules } from "./model.js";
import { Store } from "./store.js";

export async function processOne(
  store: Store,
  rules: Rules,
  options: {
    now?: number;
    leaseMs?: number;
    maxAttempts?: number;
    evaluate?: (
      order: Order,
      rules: Rules,
      now: Date,
    ) => Decision | Promise<Decision>;
  } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const job = store.claim(now, options.leaseMs, options.maxAttempts);
  if (!job) return false;
  try {
    const decision = await (options.evaluate ?? routeOrder)(
      job.order,
      rules,
      new Date(now),
    );
    store.complete(job, decision, rules, options.now ?? Date.now());
  } catch {
    // Do not persist exception messages: upstream errors can include customer data or secrets.
    store.fail(job, options.now ?? Date.now(), options.maxAttempts);
  }
  return true;
}

export function startWorker(
  store: Store,
  rules: Rules,
  intervalMs = 250,
): () => Promise<void> {
  let stopped = false;
  let active: Promise<void> = Promise.resolve();
  const tick = () => {
    active = active.then(async () => {
      if (stopped) return;
      try {
        await processOne(store, rules);
      } catch {
        console.error(JSON.stringify({ event: "worker_storage_failure" }));
      }
    });
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}
