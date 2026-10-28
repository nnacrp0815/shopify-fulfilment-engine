# Verification record

Initial implementation verified on 28 October 2026, Australia/Perth.

- Strict TypeScript compilation: passed with Node 24.14.1.
- Automated suite: 48 tests passed, including actual loopback HTTP requests, SQLite persistence, rollback, multiple connections, stale snapshots, retry budgets and worker recovery.
- Formatting: passed.
- Credential-free command-line demo: six signed HTTP webhooks plus one duplicate produced three routed, two held and one ignored decision, with four proposed tasks.
- Browser smoke check: clicked all six sample scenarios and verified the resulting decisions, reason codes, completed inbox records and proposed work. The [screenshot](images/demo.jpg) records fictional data from this check.
- Shopify schema validation: both `ReadFulfilmentOrder` and `PlanFulfilmentOrderMove` accepted against Admin GraphQL `2026-10` by Shopify's validation toolkit. No live API operation was executed.
- Production dependency audit: no vulnerabilities reported at verification time. This is a point-in-time dependency check, not a security certification.
- GitHub CI is configured to repeat formatting, compilation, tests, the demo and the production dependency audit on Linux and macOS. See the repository's Actions page for the current run status.

No live store, OAuth installation, 3PL, carrier, inventory reservation or mutation was tested. No load-test or full accessibility audit is claimed. These remain separate deployment checks, as described in the README and runbook.
