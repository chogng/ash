# Product resources

This directory owns product resources that are shared across Ash clients or
need a renderer-independent source of truth.

## Product services

`product-services/` is the release-owned trust bundle copied to
`ash-resources/product-services/` by both package assemblers. Its
`product-services.json` uses schema version 2 and lists named HTTPS Marketplace sources under
`marketplaces`. Each source references its own contained `trustedRoot` file; the product's `ash`
source pins `marketplace-root.json`. Roots are public verification material, never signing keys.
Both package assemblers require unique source names and every referenced regular, unlinked root file.

Packaged Desktop/server hosts, `ash code`/TUI, and app discover this file through the shared
App Server client + `ash-install-context` boundary. Each host explicitly injects the typed result;
an explicit `ASH_PRODUCT_SERVICES_PATH` remains authoritative for development and specialized hosts.
Marketplace URLs or root replacement must not move into user configuration or Plugin metadata.

The independent Marketplace source, public root owner, publishing pipeline, and key rotation
procedure live in the private [`marketplace`](https://github.com/chogng/marketplace) repository.
Ash is one optional consumer: this product bundle chooses to pin that root, while Marketplace
validation and publication do not depend on Ash. A root rotation must be valid in the Marketplace;
Ash then updates its pinned copy before requiring metadata signed only by the rotated root.

## Application branding

Application icons are fixed and do not change with the editor color theme.
The Windows artwork comes from `win32/ash.svg`; the macOS, Linux, and Web
artwork comes from `app-ts/src/ash/workbench/browser/media/ash-light.svg`.

- `win32/ash.ico` contains 16, 24, 32, 48, 64, 128, and 256 pixel PNG images
  rendered from `win32/ash.svg`. Run `pnpm app-icon:generate` after changing
  the SVG and `pnpm app-icon:check` to verify the generated icon. Electron
  development windows load the ICO directly. The Windows packaging command
  embeds it in `Ash.exe`.
- `darwin/ash.icns` is the macOS application bundle icon.
- `linux/ash.png` is the Linux desktop and window icon.
- `server/` contains the Web favicon, install icons, and manifest.

Vite copies `server/` unchanged to the renderer output root, and the browser
Workbench and Sessions pages link those stable paths. On Windows x64,
`pnpm package:desktop:win32` creates an Electron bundle and an Inno Setup
installer under `dist/`. The bundle command builds the TypeScript host and
renderer, packages a Windows App Server, embeds `win32/ash.ico` in `Ash.exe`,
and includes the required resources. The installer requires Inno Setup 6's
`ISCC.exe` on `PATH`, or its full path in `ISCC_PATH`. Both installer shortcuts
use the same application ID as the running Electron process. Run
`pnpm --dir app-ts package:win32:verify` to launch the packaged Workbench with
Playwright after building the bundle.

`ash-dark.svg` remains a renderer-only titlebar variant and is not a packaging
source.

## Icons

The cross-client ownership and rendering contract is documented in [`docs/icons.md`](../docs/icons.md).

`icons/*.svg` is the only hand-maintained input for Ash product icons. Add, replace, or remove an SVG and run `pnpm icons:generate` from the repository root; `build/resources/icons/generate.ts` canonicalizes the SVG and generates `icons/manifest.json`, `app-ts/src/ash/base/common/productIcons.ts`, and `app-rs/icons/src/generated.rs` together through `generate-to-ts.ts` and `generate-to-rs.ts`.

- SVG filenames use lowercase kebab-case and become the icon IDs without a second mapping table.
- `manifest.json` is generated output; do not edit its `file` or `rendering` fields.
- The browser-only Seti file-icon theme is owned by `app-ts/src/ash/platform/theme/browser/media/seti` and remains separate from product icons.
- Renderer-specific tinting, caching, rasterization, and component layout remain in each client.

The generator uses SVGO with multiple passes, removes fixed root dimensions while preserving `viewBox`, prefixes SVG IDs, rejects active or linked content, and infers `symbolic` or `multicolor` from the optimized paint values. `pnpm icons:check` verifies the SVGs and all generated outputs without modifying files; `pnpm test:icons` covers generation, optimization, deletion, safety checks, manifest metadata, and the Vite update path.
