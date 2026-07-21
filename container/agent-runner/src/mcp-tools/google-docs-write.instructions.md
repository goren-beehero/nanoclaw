### Google Docs writes

Use `update_google_document` for requested edits to an existing Google Doc. Read
the current document first, calculate indices from that fresh content, and send
all edits for that document in one `requests` batch when practical. Never use
raw `POST`, `PUT`, `PATCH`, or `DELETE` calls to Google Docs or Drive as a
fallback. If the tool says the sender is not authorized, explain that boundary
and do not retry or seek a bypass.
