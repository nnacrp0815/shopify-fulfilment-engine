# Security

Do not post credentials, real customer payloads or databases in public issues. For a vulnerability, use GitHub's private vulnerability reporting if it is enabled; otherwise contact the repository owner through a private channel you already trust. No private reporting address is invented here.

The demo uses fictional orders and generates an ephemeral signing key. Service mode requires explicit secrets and restricts operational API reads to a bearer token. Keys and tokens are never placed in URLs or browser storage. `.env`, database files, logs and build output are excluded from version control.

Raw-body HMAC verification precedes parsing. The service enforces a configured shop and topic allowlist. Only the minimal operational order representation is persisted; it still contains order identifiers and must be protected. This MVP does not implement app installation, OAuth/session storage, mandatory privacy-webhook processing, inventory reservations, live effects or full production monitoring.

Before adapting it to real stores, review the deployment threat model, app permissions, protected-customer-data requirements, secret rotation, database retention, backups, HTTPS/reverse-proxy controls and reconciliation. Dependency and CI changes should be reviewed like application code.
