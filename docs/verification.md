# Verification record

Initial implementation verified on 28 October 2026, Australia/Perth.

- Strict TypeScript compilation: passed with Node 24.14.1.
- Automated suite: 52 tests passed after the interface refresh, including actual loopback HTTP requests, SQLite persistence, rollback, multiple connections, stale snapshots, retry budgets, worker recovery and the shared standalone preview.
- Formatting: passed.
- Credential-free command-line demo: six signed HTTP webhooks plus one duplicate produced three routed, two held and one ignored decision, with four proposed tasks.
- Browser smoke check: the original engine demo exercised all six signed scenarios. The refreshed interface was checked for filters, search, empty states, scenario creation, plain-language decisions, keyboard focus, Escape dismissal, focus return and a connected pickup event. A phone-sized 390 × 844 viewport had no horizontal overflow and a usable scenario dialog. The [screenshot](images/demo.jpg) shows fictional data in the refreshed preview.
- Standalone preview: the generated routing bundle was run in an isolated JavaScript environment with no network, module loader or Node APIs, and compared with the backend function. Asset paths and the portable HTML were checked separately. Automated browser inspection of `file://` pages is unavailable; visual browser checks used the served interface.
- Shopify schema validation: both `ReadFulfilmentOrder` and `PlanFulfilmentOrderMove` accepted against Admin GraphQL `2026-10` by Shopify's validation toolkit. No live API operation was executed.
- Production dependency audit: no vulnerabilities reported at verification time. This is a point-in-time dependency check, not a security certification.
- GitHub CI is configured to repeat formatting, compilation, tests, the demo and the production dependency audit on Linux and macOS. See the repository's Actions page for the current run status.

No live store, OAuth installation, 3PL, carrier, inventory reservation or mutation was tested. No load-test or full accessibility audit is claimed. These remain separate deployment checks, as described in the README and runbook.
