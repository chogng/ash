# Ash Markdown parsing extension

An independent Rust executable using `ash-external-ext-sdk` and the existing
product extension supervisor. It activates on `_markdown.parse`, requires only
the Command capability, and does not read workspace files, use the network or
request credentials.
Profile enablement and the exact product executable gate execution.

The version 1 command accepts one object with `protocol_version`, `uri`, `version`
and `text`. It returns the same protocol/document identity and `blocks`, containing
render nodes and UTF-16 source ranges. The URI is an opaque correlation value,
never a file read request. Invalid versions, malformed input and oversized source
are rejected. The source limit is 16 MiB UTF-8; transport payload/frame limits are
24/32 MiB, so a heavily escaped snapshot or very large render tree can reach the
transport limit first. The shared client command/editor envelope accepts up to
64 MiB of encoded JSON, 1,000,000 values, 262,144 entries per collection and depth
160, allowing a source snapshot and its render tree together. Independent process
quotas remain separately enforced by the host; ordinary extensions keep their
default 512 KiB payload allowance. The document is delivered by the host's initial
update queue instead of embedding it again in HTML. Cancellation/deadlines are
observed during parsing.

The extension retains no document, history or persistence state. The browser
Markdown extension calls the command through the shared host and retains only
results matching its render request. The standard `executeCommand` API has no
caller cancellation parameter: superseded UI results are discarded; in-flight
parsing remains subject to host deadline, revocation and process shutdown.

Run `just verify ash-markdown-parser` for parser and real supervisor/process tests.
`pnpm prepare:backend` builds and packages the executable for Desktop and remote
hosts. No WebAssembly target, bindings generator or parser JS runtime is needed.
