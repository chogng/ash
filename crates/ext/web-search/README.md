# Web Search extension

`ash-web-search-extension` provides the eager `web-search` agent tool. It validates a bounded,
provider-neutral query contract and delegates execution to a host-injected `WebSearchBackend`.

Installing the extension declares exact network and optional credential scopes through the
capability-bearing extension API. App Server freezes those scopes into the action digest and asks
for one-time external-access approval before execution. With no backend installed, the tool is not
registered.

`JsonWebSearchBackend` supports a JSON-over-HTTP service that accepts `WebSearchRequest` and returns
`WebSearchResponse`. Ash deliberately does not hard-code Codex's private standalone search
endpoint; product hosts may bind an OpenAI-compatible gateway, an enterprise search service, or a
self-hosted adapter.
