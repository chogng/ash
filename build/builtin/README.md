# Builtin extension build

This directory prepares the complete builtin package set from `extensions/`. `extensions.ts`
compiles required browser entrypoints and stages manifests, NLS, language catalogs and assets
as immutable per-package directories in `.build/builtin/packages/`. It publishes `current.json`
atomically after every package is ready; unchanged packages retain their directory identities.
The Rust App Server selects those exact directories, validates and freezes their contents,
and serves the sole runtime catalog and all package resources. Vite watches build inputs but
provides no client catalog or resource fallback.

`pnpm prepare:extensions`, the Desktop Vite plugin and shared package preparation use this
owner. `__init__.py` copies the published builtin directories into `ash-resources/extensions`
for installed products. Rust source and Cargo inputs are excluded; Rust provider executables
are built and signed separately. Language catalogs are generated before preparation and
staged at each language pack manifest's `localization/package.json` path.

Git and Markdown retain necessary browser/editor entrypoints. Compiled dependencies are
bundled into one module, replacing the entry resource; unused samples and assets remain.
Workbench and Agents Window fetch that module through the same Rust catalog/resource
interface before starting their generic Workers. A readable package does not imply code
execution authority: explicitly supplied `ASH_WEB_EXTENSION_PATHS` packages retain user
provenance and require backend admission to execute.

`.build/builtin/fixture.json` is only a test fixture for unit and browser integration scenarios.
Production clients do not import it. Initial NLS caches and base UI colors remain client
bootstrap resources so disconnected windows can display a localized connection diagnostic.
