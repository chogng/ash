# Built-in extensions

> This README owns the repository package-set and distribution contract. The cross-layer runtime,
> trust, refresh, and evolution contract is maintained in
> [`docs/editor-extensions.md`](../docs/editor-extensions.md); the Rust catalog implementation is
> documented in [`crates/external-ext/src/packages/README.md`](../crates/external-ext/src/packages/README.md).

This directory contains extension package sources and declarative resources shipped with Ash. Packaging
places the same directory under `ash-resources/extensions/`.

Except for this README and `BUILD.bazel`, each direct child must be a package directory with a
`package.json`. TextMate packages may put raw JSON or PLIST grammars below the package and reference
them from `contributes.grammars[].path`.
Built-in language packages own Tree-sitter queries in `queries/` and parser declarations in `tree-sitter/grammars.json`.
Additional query sets cover CSS/SCSS/Less, Go, HTML, JSON/JSONC, Python, Shell, INI/Properties,
Markdown (block and inline), SQL, TOML, XML/DTD/XSL, YAML, Diff, Git commit/rebase/ignore,
and Starlark/Bazelrc. Each package's `queries/README.md` pins the upstream grammar revision,
lists source files and licenses, and records query composition or local compatibility changes.
Existing JavaScript/JSX, TypeScript/TSX and Rust capture names remain adapted to editor theme scopes;
new query sets retain upstream capture names. Git ignore highlights are authored in Ash because
its upstream grammar ships no queries.

All built-in languages use the same package declarations. `pnpm tree-sitter:generate`
produces the Rust language registry, protocol enum and server adapter, plus the Web
language metadata and WASM/query imports. It includes editor IDs, code-fence aliases,
embedded-language IDs, and query composition. Rust parsers remain statically linked
Cargo dependencies; browser parsers remain bundled WASM assets. This registry serves
the built-in package set and does not introduce per-language processes.

The declarative loader reads resources without executing package code. Packages with a `browser`
entry, including `markdown-language-features`, are separately bundled and executed by the TS
browser extension host. This directory holds packages, not the SDK or runtime implementation.

TS/JS packages use the selected extension runtime and public compatibility API. Independent Rust
capabilities use the [`Rust SDK`](../sdk/rust/README.md), the same versioned host transport,
and granted core services. [`github-authentication`](github-authentication/README.md) is the first
profile-scoped Rust capability: it owns GitHub sessions for App without becoming a default TUI
startup dependency. [`github`](github/README.md) separately owns the REST/GraphQL API capability,
activated on demand under the same profile. See the [architecture decision](../docs/editor-extensions.md#0-确定的产品方向)
for the two extension categories and current compatibility paths.

## Source and distribution boundary

This directory is a runtime input, not a download endpoint. Built-in packages committed here are
copied into `ash-resources/extensions/` during development and production packaging. Rust source
packages also build an independent executable in `bin/`; the runtime does not compile their sources. TS builds and loads the built-in editor assets directly. App Server validates installed external
package resources through `ash-external-ext::packages`. A running application does not authenticate to a Git repository to load built-in extensions.

Extensions language packages are maintained in the separate `ash-extensions` repository. That
repository owns versioned sources, server entrypoints, dependency locks, build recipes, licenses,
and signed releases. Node server dependencies are assembled during publication and included in the
signed language ZIP; Ash downloads that package when the user installs it. Ash owns installation,
activation, permissions, and process execution. Static language
assets are exposed through the extension catalog; server routes are read from the signed language
catalog and handled by the shared Rust LSP client.

The bundled packages retain their package-level `NOTICE.md` provenance. Most are derived
from `microsoft/vscode`; Bazel comes from `bazel-contrib/vscode-bazel` and TOML from Taplo,
with their licenses included inside those packages. The canonical VS Code MIT license copy is
[`third_party/vscode/LICENSE.txt`](../third_party/vscode/LICENSE.txt); both production and Desktop
development packaging place it at `ash-resources/licenses/vscode/LICENSE.txt` alongside the
extension packages.

User-installed extensions are a separate profile-level root. Extensions packages use the signed registry and remain separate from these built-in resources.

## Bundled packages

[`git`](git/README.md) is a browser TypeScript extension owning Git commands and SCM presentation.
App Server and `ash-git` retain the shared repository, history, watcher and execution capabilities
used independently by Desktop, Agent and TUI. `build/builtin` bundles the frontend and stages its
metadata; the shared runtime package needs no separate Git extension executable.

`remote-ssh` registers the product's `ssh` authority resolver through the TS SDK in the Rust V8
host. Its `main` entry and SDK are compiled into the executable; App Server verifies their release
binding. It selects a saved connection name; the Remote service validates the target and the
connection host owns confirmation-bound execution, credentials, processes and new-window lifetime.
Product authority admits only this compiled module and grants no workspace file access, so it can
start without a workspace. Installed packages use the same SDK and host with their existing
workspace authorization; they cannot request the product authority. Browser Workers cannot
register `ssh`, and there is no core resolver fallback.

`academic` declares the optional Academic document editor, using the shared Stanza
profile, model, undo, save and collaboration services. Its file associations and
editor registration follow extension enablement; see [Academic](academic/README.md).
Pagination and PDF export remain future work.

`markdown-language-features` ships the Markdown preview browser extension. `media-preview`
declares the image (PNG/JPEG/WebP), audio (MP3/WAV/OGG/OGA), and video (MP4/WebM) editors.
TS packages and loads its metadata and resources in both Web and Electron. Its `customEditors` declarations select product-owned TS
renderers, so it has no executable extension entry. File selectors and optional MIME types
live in the manifest, and editor labels in its English and Chinese NLS resources. Playback
and codec support belong to the browser/Electron media engine.

The current declarative pack contains the following package directories:

- `bazel` (Starlark/bazelrc), `css` (CSS/Less/SCSS), `diff`, `git-base`, `go`, `html`, `ini`, `javascript`, `json`, `markdown-basics`, `python`, `rust`, `shellscript`, `sql`,
  `toml`, `typescript-basics`, `xml`, and `yaml` provide language IDs, file associations, language
  configuration, Tree-sitter queries/parsers, and—where upstream provides them—snippets.
  Bazel associates `BUILD`, `WORKSPACE`, `MODULE.bazel`, `.bazel`, and `.bzl` files with
  Starlark; `.bazelrc` and `bazel.rc` use a separate configuration grammar. Starlark
  editing includes comment toggling, bracket/quote pairs, block indentation, and folding.
  Git resources associate ignore/exclude files, commit/merge messages, rebase plans,
  Git configuration files, and diff/patch files with their grammars. Ignore rules
  highlight comments, negation, wildcards, character classes, and escapes. Commit
  messages include diff highlighting, and rebase `exec` commands include Shell
  highlighting. Markdown fenced blocks reuse these same grammars.
- `theme-seti` provides the Seti file icon document, font, and third-party notices.
- `theme-defaults` provides VS Code-derived syntax themes and the four Ash color themes.
  The Workbench loader also resolves package-relative JSON `include` files when a theme uses them.
  Each Ash theme declares its syntax parent using `include` and supplies its own window colors.
  All themes load through manifest contributions before the window's theme service starts.
  UI-only hosts read a generated bundle of these same package resources through the extension API.
  Markdown grammar and language settings stay in `markdown-basics`; Markdown colors and font
  styles belong to `theme-defaults`. Users override syntax styles with
  `editor.tokenColorCustomizations.textMateRules`. The `editor.action.inspectTMScopes` command
  reports the active tokenizer's captures/scopes and resolved syntax style.

Built-in languages use Tree-sitter by default. Rust links the grammar dependencies in
`ash-syntax`; the Web Worker loads portable parser assets from each language package.
Queries live in `queries/` beside their provenance and licenses. JavaScript, TypeScript
and Rust use the existing `@vscode/tree-sitter-wasm` assets; the other parser assets and
hashes are declared in each package's `tree-sitter/grammars.json`. Both runtimes register
parsers and queries generated from these manifests; package-supplied WASM paths are
resolved from the locked dependency. The generated files and assets are checked during
normal build preparation:

```sh
pnpm tree-sitter:generate
pnpm tree-sitter:verify
ASH_TREE_SITTER_CLI=/path/to/tree-sitter pnpm tree-sitter:build <grammar>
```

Use Tree-sitter CLI 0.26.3 and wasi-sdk 29 for reproducible rebuilds. `gitcommit` also
requires `ASH_WASI_CC=/path/to/wasi-sdk-29/bin/clang`: its generated lexer is split into
small equivalent state helpers for LLVM, and only the required `iswcntrl` libc object
is linked (license in `git-base/tree-sitter/musl.LICENSE.txt`). The shipped parser is
compared with the original C parser against all 64 upstream corpus examples.
Gitignore and bazelrc have package-local Rust bindings because their upstreams do not
publish usable Cargo bindings; they do not introduce another shared syntax engine.
The generic TextMate loader remains available for external extension contributions.

The manifest is the only source of contribution metadata. `AppServerExtensionService` receives
Rust-validated package resources and projects languages/configuration/snippets/grammars/theme metadata/
debuggers into their Workbench-owned registries. `ExtensionColorThemeService` owns selectable color
theme registrations; the browser TextMate runtime never imports package files directly.
Theme documents provide the active
TextMate token scope rules.

Supported declarative fields are deliberately narrower than a VS Code extension host:

| Contribution                                                             | Current state                                                                                                            | Owner                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `languages`, file/first-line associations, `language-configuration.json` | ✅ loaded and registered                                                                                                 | Editor language registry/configuration                   |
| `snippets`                                                               | ✅ 有 prefix 的 snippet 注册为 completion；file template 可通过 `New File from Template` 创建 untitled editor            | Editor language completion / extension template registry |
| `grammars`                                                               | ✅ loaded through client built-in assets or validated external resources and TextMate snapshots                          | Workbench TextMate service                               |
| `embeddedLanguages`, `tokenTypes`, bracket scope metadata                | ✅ validated, transported, and projected to Stanza token language/type/bracket metadata                                  | TextMate adapter                                         |
| `iconThemes`                                                             | Loaded from package resources; supports font and SVG/PNG file icons, light variants, and `workbench.iconTheme` selection | Workbench theme service                                  |
| `themes`                                                                 | ✅ 严格解析、版本化 catalog、Workbench theme registration 和 active TextMate token projection                            | Extension/theme/TextMate services                        |
| `debuggers`                                                              | ✅ 窄声明式 adapter command discovery；不提供 VS Code Debug Extension API                                                | Extension registry / Debug service                       |
| `configurationDefaults`, `semanticTokenScopes`                           | 尚未接入；bundled manifest 中的字段不会被投影                                                                            | 后续领域 adapter                                         |
| extension JavaScript                                                     | 声明式扫描不执行；可信 `browser` 包由独立 Worker 路径执行                                                                | TS 扩展宿主                                              |
| Extensions LSP executable                                                | 由已验证 catalog 映射并运行                                                                                              | App Server / LSP manager                                 |

User packages are read from the host-selected profile extension root, but the current Editor
Extension system has no registry, download, enable/disable, signature, or grant authority. Built-in
roots have precedence, so a profile package with the same extension ID is diagnosed and cannot
silently replace product resources. Manifest `%...%` localization placeholders and complete
Workbench theme labels fall back to the theme document or stable manifest identity when localization
placeholders cannot be resolved.
