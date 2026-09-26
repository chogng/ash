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

`githubAccount.clientId` is the public Client ID of Ash Desktop's GitHub OAuth App. The
Welcome page uses it for GitHub device authorization. The GitHub adapter stores access and
refresh tokens in the profile secret store and exposes only the account name and status to
the editor. This account connection is separate from Plugin connector OAuth settings.

The independent Marketplace source, public root owner, publishing pipeline, and key rotation
procedure live in the private [`marketplace`](https://github.com/chogng/marketplace) repository.
Ash is one optional consumer: this product bundle chooses to pin that root, while Marketplace
validation and publication do not depend on Ash. A root rotation must be valid in the Marketplace;
Ash then updates its pinned copy before requiring metadata signed only by the rotated root.

## Application branding

Application icons are fixed and do not change with the editor color theme.
`branding/ash-app-black-512.png` is the supplied flat reference artwork for
application icons. The macOS Dock uses the layered `darwin/ash.icon`; the Linux
and Web clients have their own raster files. The Windows application icon uses
the same mark on a black rounded square in `win32/ash.svg`. The titlebar and
editor welcome page use the cropped transparent
`app-ts/src/ash/workbench/browser/media/ash-mark.svg`,
tinted by their foreground color. The system tray uses transparent monochrome
artwork from `tray/`.

- `win32/ash.ico` contains 16, 24, 32, 48, 64, 128, and 256 pixel PNG images
  rendered from `win32/ash.svg`; `win32/ash-512.png` is the Rust window icon
  rendered from that same SVG. Run `pnpm app-icon:generate` after changing the
  Windows source and `pnpm app-icon:check` to verify both outputs.
  Electron development windows load the ICO directly. The Electron packaging
  command embeds it in `Ash.exe`, and the Rust `app` build embeds it in `app.exe`.
- `darwin/ash.icon` is the editable layered macOS app icon. Its black background
  and white Ash mark are compiled into the application asset catalog on a macOS 26
  build host with Xcode 26. macOS 26 uses this asset; `darwin/ash.icns` provides
  the icon on earlier macOS versions. `darwin/ash.png` lets Electron set the
  same artwork on the Dock during development. Run `pnpm macos-icon:generate`
  after changing the `.icon` file or the macOS menu bar SVG.
- `linux/ash.png` is the Linux desktop and window icon.
- The Rust Workbench embeds `win32/ash-512.png` for its Windows window icon.
- `server/` contains the Web favicon, install icons, and manifest.
- `tray/ash-black.svg` and `tray/ash-white.svg` are transparent monochrome
  tray artwork. Windows uses 16, 24, and 32 pixel PNGs across display scales.
  macOS uses 18, 27, and 36 pixel black PNGs as a system template; the 18-point
  canvas keeps Ash's visible mark in scale with other menu bar icons.

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

The Windows Electron host installs a theme-aware tray icon, and the macOS host
installs a template menu bar icon. Clicking either icon focuses the Workbench.
Closing the last window still exits the application on Windows; macOS keeps the
application running so the Dock and menu bar icon can reopen a Workbench window.

## Replacing the application icon

Run the commands below from the repository root. The Dock, menu bar, and other
platforms use separate artwork; changing one file does not update the others.

| Where it appears | Edit | Update alongside it |
| --- | --- | --- |
| macOS Dock and Finder | `darwin/ash.icon/Assets/ash-white.svg` in Icon Composer; adjust `darwin/ash.icon/icon.json` there if the layer name, background, or scale changes | `darwin/ash.png` for the development Dock and `darwin/ash.icns` for older macOS releases |
| macOS menu bar | `tray/ash-black.svg` | `tray/ash-black-{18,27,36}.png` |
| Windows notification area | `tray/ash-black.svg` and `tray/ash-white.svg` | Both colors at 16, 24, and 32 pixels |
| Windows application and Rust window | `win32/ash.svg` | Run `pnpm app-icon:generate` to update `ash.ico` and `ash-512.png` |
| Linux and Web | The chosen application artwork | `linux/ash.png`, `server/favicon.ico`, `server/ash-192.png`, and `server/ash-512.png` |
| Workbench titlebar and welcome page | `app-ts/src/ash/workbench/browser/media/ash-mark.svg` | Check its appearance in each theme |

For the macOS Dock, open `darwin/ash.icon` in Xcode's Icon Composer, replace the
layer artwork, preview the icon at small Dock sizes, and save the `.icon` file.
Keep `icon.json`'s `image-name` aligned with the file in `Assets/`. If the menu
bar mark changes, edit `tray/ash-black.svg` as a separate transparent black
image without the Dock background. Then generate and check all five macOS
outputs with Xcode 26 installed in `/Applications/Xcode.app`:

```sh
pnpm macos-icon:generate
pnpm macos-icon:check
```

Set `DEVELOPER_DIR` if Xcode is installed elsewhere.

The command compiles the `.icon` file to `darwin/ash.icns`, extracts
`darwin/ash.png` for the development Dock, and rasterizes the menu bar SVG to
18, 27, and 36 pixels. Electron marks the black menu bar image as a macOS
template so the system chooses its displayed color. The 18-pixel image sets
the layout size; the others cover 1.5× and 2× displays.

If the Windows notification area artwork also changes, regenerate both colors
at 16, 24, and 32 pixels:

```sh
for color in black white; do
  for size in 16 24 32; do
    sips -s format png -z "$size" "$size" "resources/tray/ash-${color}.svg" --out "resources/tray/ash-${color}-${size}.png" >/dev/null
  done
done
```

Keep the transparent canvas and check the **visible mark size**, not only the
PNG dimensions; a large transparent margin makes the menu bar icon appear too
small.

After replacing assets, run `pnpm app-icon:check` if the Windows application
icon changed. Set `ASH_UPDATE_PUBLIC_KEY` to a 64-digit hex public key, then run
`pnpm --dir app-ts package:darwin:bundle --unsigned` and
`pnpm --dir app-ts package:darwin:verify` for a local macOS package check. The
bundle command needs the full Xcode toolchain; if Command Line Tools is selected,
set `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` for that command.
Bundling compiles `ash.icon` and checks the menu bar PNGs are present; the
verification step launches the packaged app with Playwright. Relaunch the
development or installed application to load changed menu bar PNGs, and check
the Dock and menu bar at their actual display sizes. Apple's [Icon Composer
guide](https://developer.apple.com/documentation/xcode/creating-your-app-icon-using-icon-composer)
explains layer replacement and platform previews.

## Icons

The cross-client ownership and rendering contract is documented in [`docs/icons.md`](../docs/icons.md).

`icons/*.svg` is the only hand-maintained input for Ash product icons. Add, replace, or remove an SVG and run `pnpm icons:generate` from the repository root; `build/resources/icons/generate.ts` canonicalizes the SVG and generates `icons/manifest.json`, `app-ts/src/ash/base/common/productIcons.ts`, and `app-rs/icons/src/generated.rs` together through `generate-to-ts.ts` and `generate-to-rs.ts`.

- SVG filenames use lowercase kebab-case and become the icon IDs without a second mapping table.
- `manifest.json` is generated output; do not edit its `file` or `rendering` fields.
- The browser-only Seti file-icon theme is owned by `app-ts/src/ash/platform/theme/browser/media/seti` and remains separate from product icons.
- Renderer-specific tinting, caching, rasterization, and component layout remain in each client.

The generator uses SVGO with multiple passes, removes fixed root dimensions while preserving `viewBox`, prefixes SVG IDs, rejects active or linked content, and infers `symbolic` or `multicolor` from the optimized paint values. `pnpm icons:check` verifies the SVGs and all generated outputs without modifying files; `pnpm test:icons` covers generation, optimization, deletion, safety checks, manifest metadata, and the Vite update path.
