# ADR 0001: Durable read-only Salesforce boundary for Bobi

Status: accepted for implementation, production attachment separately gated.

## Context

Bobi's former Hosted MCP used shared rotating OAuth state across concurrent session containers. A refresh race could invalidate the shared token family. The Hosted MCP also does not support the required machine-to-machine client-credentials flow.

## Decision

Run one persistent adapter container on the NanoClaw EC2 host. It owns the in-memory Salesforce access token and exposes only the six `platform/sobject-reads` compatible operations. Session containers run a credential-free stdio MCP client and reach the adapter only on `bobi-salesforce-private`, a Docker bridge with no published ports.

OneCLI injects the External Client App credential only into the exact token POST. Bobi receives neither that credential nor the Salesforce bearer token. The live API identity has broader permissions than desired, so the adapter is the current hard read-only boundary: fixed hosts and GET/query resource families, strict schemas and bounds, and no generic proxy or write method.

The operator-controlled network-attachment file is outside Bobi's writable configuration and accepts only the compiled allowlisted network name. It fails closed when malformed and is incompatible with NanoClaw egress lockdown until a reviewed multi-network policy exists.

## Failure and rollback

There is no automatic fallback to the removed Hosted MCP. Failed authentication makes the adapter unready and returns a sanitized error. Docker restarts crashed adapter processes. Rollback manually removes both task-owned MCP namespaces, adapter/network artifacts, and restores the pinned immutable no-Salesforce baseline from the verified Phase 0 bundle.

## Consequences

This removes the refresh-token race and isolates credentials, but remains single-host rather than highly available. Future writes require a separate credential and named-operation service with approval and audit; they must not expand this adapter.
