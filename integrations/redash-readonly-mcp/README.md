# BeeHero Redash read-only MCP

This server gives Bobi a narrow Redash API surface. Authentication is injected
by OneCLI's HTTPS proxy; the process must never receive `REDASH_API_KEY`.

## Tools

- `get_redash_dashboard`
- `get_redash_query`
- `get_redash_cached_query_result`
- `run_redash_dashboard`

Only saved queries already attached to the requested dashboard can be executed.
Raw SQL, query/dashboard mutation, sharing, alerts, widgets, data-source access,
and arbitrary URLs are not implemented. User-provided text and query-backed
parameter overrides are rejected.

## Runtime

```sh
REDASH_URL=https://internal.beehero.io npm start
```

The NanoClaw container must be configured by the OneCLI SDK so HTTPS requests
flow through the gateway. OneCLI stores the API key as a generic secret for the
exact host and injects `Authorization: Key {value}`.
