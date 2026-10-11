# Builtin extension build

This directory owns Ash's builtin extension resources. `extensions.ts` prepares the browser
catalog and its immutable resource snapshots, and bundles browser entrypoints for Vite.
`__init__.py` stages and validates backend extension resources for the shared package assembler.
Both retain Rust provider manifests and NLS resources while excluding Rust sources and Cargo
inputs; the shared backend build separately produces and signs each Rust executable.

`pnpm prepare:extensions`, the Desktop Vite plugin and shared package preparation use these
owners. Package selection comes from this checkout's `extensions/`; external browser packages
can be explicitly supplied through `ASH_WEB_EXTENSION_PATHS`.

A package can contain both a Rust capability and a browser frontend. Git's `browser` entry is
bundled with the public `ash` and supported `vscode` modules into its Worker resource; its manifest
and NLS travel with the same browser catalog. Desktop and Sessions load that entry through their
generic extension hosts rather than linking Git frontend classes into renderer assemblies.
