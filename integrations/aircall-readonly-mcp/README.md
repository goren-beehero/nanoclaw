# BeeHero Aircall read-only MCP

This server gives Bobi a narrow Aircall API surface for customer-call analysis.
Authentication is injected by OneCLI's HTTPS proxy; the process must never
receive an Aircall API ID, token, or prebuilt `Authorization` value.

## Tools

- `aircall_ping`
- `list_aircall_calls`
- `get_aircall_call`
- `get_aircall_call_intelligence`
- `list_aircall_users`
- `list_aircall_numbers`
- `list_aircall_tags`
- `list_aircall_teams`

The connector only issues allowlisted `GET` requests under
`https://api.aircall.io/v1`. It blocks mutations such as transfers, comments,
tags, archive/unarchive, recording deletion, message sending, contacts/users
updates, and webhook management.

Call-list requests are bounded to at most 31 days and 100 rows per page.
Conversation Intelligence endpoints are single-call only. External phone
numbers and recording/voicemail/asset URLs are redacted from tool output by
default; transcript text is returned only through the single-call intelligence
tool so Bobi can analyze a call without bulk transcript export.

## Runtime

```sh
AIRCALL_URL=https://api.aircall.io npm start
```

OneCLI stores the Aircall Basic Auth credential as a generic secret for
`api.aircall.io`, path `/v1/*`, header `Authorization`, value format
`Basic {value}`. The stored value is the Base64 encoding of
`API_ID:API_TOKEN`.
