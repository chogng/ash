# Ash TypeScript extension example

This package uses `@ash/sdk` and contains only TypeScript author code. Install its development
dependencies and run `npm run build`, then install this directory through Ash's existing local
Plugin installer. Enable the extension and grant its requested directory-read permission.
The `ash.example.inspect` command takes a native filesystem path within the authorized workspace
and returns its persisted UTF-8 contents from the Rust filesystem service. It does not read
unsaved editor text. Its command title is available in English and Simplified Chinese.

The package manifest declares the command; `.ash-plugin/plugin.json` explicitly selects
`api: ash` and requests directory access. Installation does not grant execution or file access.
The product host binds `@ash/sdk` to this exact extension instance and forwards file requests
through the existing Host RPC. Rust validates package permission and workspace containment.
Command cancellation and extension retirement revoke the corresponding requests.

The [SDK](../../../sdk/typescript/README.md) supplies its own types and has no Rust or Ash
source dependency. Keep `@ash/sdk` external if bundling this extension. The current local
Plugin envelope is a migration path; `.ashx` packaging has not been implemented yet.
