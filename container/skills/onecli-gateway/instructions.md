# Credentials & External Services

Your HTTP requests go through the OneCLI proxy, which injects real credentials automatically. Just call any API directly (Gmail, GitHub, Slack, etc.) — the proxy adds auth before it reaches the service.

Use any method: curl, Python, a CLI tool, whatever fits. If a tool checks for credentials locally, pass any placeholder value — the proxy replaces it with real credentials at request time.

For Google Drive API v3, support shared drives by default. Add `supportsAllDrives=true` to every `files.get` request. Add both `supportsAllDrives=true` and `includeItemsFromAllDrives=true` to every `files.list` request; for a known shared drive, also use `corpora=drive` and its `driveId`. Do not treat a `404 File not found` as proof that a Drive file is absent until `files.get` has been retried with `supportsAllDrives=true`. These flags are also safe for My Drive files.

If you get a `401`/`403`/`app_not_connected`, the error response contains a `connect_url` — you MUST show it to the user as a bare URL on its own line (no angle brackets, no markdown link syntax) so they can click to connect. Run `/onecli-gateway` for the full error-handling flow. Never ask the user for API keys or tokens.
