# Operations runbook

## Startup and storage

Run `npm ci`, `npm run check` and `npm run demo` before release. Build once, set service environment variables through a secret manager, and run `dist/src/main.js` under a process supervisor. Keep its working directory at the repository root so configured relative paths resolve correctly. HTTPS terminates at a reverse proxy. Configure upstream body, header, connection and rate limits; do not expose the admin interface publicly without additional access controls.

Use a persistent local disk for `DB_PATH`. The containing directory is created with mode `0700`; set a restrictive service umask and ensure existing directories/files also have appropriate permissions. Run one service instance per database volume. SQLite's file and `-wal`/`-shm` siblings belong together. Do not copy a live database file alone: use SQLite's online backup API/tooling or stop the service and copy the complete checkpointed database. Test restoration on an isolated host.

`GET /healthz` reports database reachability only. Monitor HTTP errors, process availability, disk space, oldest queued age, repeated attempts, dead letters and held orders. The viewer/API shows a bounded recent snapshot; use an authorized database inspection for full queue counts. Alerts and dashboards must not log tokens or payloads.

## Webhook failures

| Response      | Meaning                                 | Action                                                                |
| ------------- | --------------------------------------- | --------------------------------------------------------------------- |
| `200`         | Matching delivery already accepted      | No action; inspect existing processing state                          |
| `202`         | Durable intake completed                | Await worker decision                                                 |
| `400`         | Unsupported topic or invalid metadata   | Check subscription headers and destination                            |
| `401`         | Invalid HMAC                            | Confirm secret and exact raw body, investigate untrusted traffic      |
| `403`         | Unexpected shop                         | Check single-shop configuration                                       |
| `409`         | Delivery ID reused with different bytes | Preserve evidence; investigate; never overwrite the existing delivery |
| `413` / `415` | Body limit or content type              | Adjust integration deliberately, without bypassing verification       |
| `422`         | Invalid normalized payload              | Inspect privately, update payload contract or adapter with tests      |
| `503`         | Storage or internal failure             | Check disk, permissions, process health; sender may retry             |

Do not assume rejected permanent deliveries will disappear: Shopify can retry non-success responses. Inspect delivery failures in your app's webhook tooling. Webhooks are not a complete reconciliation mechanism; compare authoritative current orders periodically before deploying live effects.

## Held decisions

Correct the operational cause upstream: payment, product mapping, delivery method, date, country or stock. A new order update with a newer `updated_at` can replace the hold. Simply changing a rules file does not replay completed deliveries, and unchanged snapshots do not automatically re-evaluate. Add a separately reviewed re-evaluation workflow if your deployment needs that behaviour.

For `CONFLICTING_ORDER_SNAPSHOT`, obtain a newer authoritative Shopify snapshot. Replaying conflicting old timestamps is not a repair. All earlier tasks have been superseded.

## Dead letters

Failed normalized payloads remain available in the database. After fixing the cause, copy the exact `key` string from an authorized `GET /api/state` response. Run:

```sh
node --env-file-if-exists=.env dist/src/retry.js '["your-shop.myshopify.com","orders/updated","delivery-id"]'
```

This resets only a matching dead job to queued with zero attempts; it does not accept new content or bypass order deduplication. The worker will evaluate it using its currently loaded rules. A repeated failure should be investigated rather than retried indefinitely.

## Secret rotation

Set the new client secret as `SHOPIFY_WEBHOOK_SECRET` and retain the previous one briefly in `SHOPIFY_PREVIOUS_WEBHOOK_SECRET`. Restart, verify real development-store deliveries, then remove the old secret after the documented rotation overlap and restart again. Never put either secret in a support ticket, URL, screenshot or commit. Rotate the independent admin bearer token separately.

## Retention and shutdown

SIGINT/SIGTERM stop accepting new connections, wait for active requests and worker processing, then close SQLite. A forced process exit can leave a lease; the next worker recovers it after expiry. Keep a supervisor termination grace period long enough for requests and the 30-second lease policy.

There is no automatic data-deletion job. Establish an explicit retention policy for processed delivery hashes/IDs, order decisions, superseded proposals and failed payloads. Removing delivery history shortens replay protection. Backups also require retention and deletion controls. Before public demos, use an empty demo database, not a service database.
