# Built-in extensions

> This README owns the repository package-set and distribution contract. The cross-layer runtime,
> trust, refresh, and evolution contract is maintained in
> [`docs/editor-extensions.md`](../docs/editor-extensions.md); the Rust catalog implementation is
> documented in [`ash-rs/extension-catalog/README.md`](../ash-rs/extension-catalog/README.md).

This directory contains extension package sources and declarative resources shipped with Ash. Packaging
places the same directory under `ash-resources/extensions/`.

Except for this README and `BUILD.bazel`, each direct child must be a package directory with a
`package.json`. TextMate packages may put raw JSON or PLIST grammars below the package and reference
them from `contributes.grammars[].path`.
The declarative loader reads resources without executing package code. Packages with a `browser`
entry, including `markdown-language-features`, are separately bundled and executed by the TS
browser extension host. This directory holds packages, not the SDK or runtime implementation.

Authors use the [`TS SDK`](../app-ts/extension-sdk/README.md); compiled JavaScript runs in a separate
[`Rust V8 host`](../ash-rs/js-extension-host/README.md) without Node. Editor and UI services remain
in TS; GitHub requests, Git, credentials, storage, and authorized system operations use Rust
backend APIs. The existing trusted Worker path does not yet establish third-party permission
isolation. See the [architecture decision](../docs/editor-extensions.md#0-确定的产品方向).

## Source and distribution boundary

This directory is a runtime input, not a download endpoint. Built-in packages committed here are
copied into `ash-resources/extensions/` during development and production packaging. Ash reads
that trusted package directory through `ash-extension-catalog`; App is only a future consumer extension
point. A running application does not authenticate to a Git repository to load built-in extensions.

Marketplace language packages are maintained in the separate `ash-marketplace` repository. That
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

User-installed extensions are a separate profile-level root. Marketplace packages use the signed registry and remain separate from these built-in resources.

## Bundled packages

The current declarative pack contains the following package directories:

- `bazel` (Starlark/bazelrc), `css` (CSS/Less/SCSS), `diff`, `git-base`, `go`, `html`, `ini`, `javascript`, `json`, `markdown-basics`, `python`, `rust`, `shellscript`, `sql`,
  `toml`, `typescript-basics`, `xml`, and `yaml` provide language IDs, file associations, language
  configuration, TextMate grammars, and—where upstream provides them—snippets.
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
  reports the cursor's TextMate scopes and resolved syntax style.

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
| `grammars`                                                               | ✅ loaded through Rust resource APIs and TextMate catalog snapshots                                                      | Workbench TextMate service                               |
| `embeddedLanguages`, `tokenTypes`, bracket scope metadata                | ✅ validated, transported, and projected to Stanza token language/type/bracket metadata                                  | TextMate adapter                                         |
| `iconThemes`                                                             | Loaded from package resources; supports font and SVG/PNG file icons, light variants, and `workbench.iconTheme` selection | Workbench theme service                                  |
| `themes`                                                                 | ✅ 严格解析、版本化 catalog、Workbench theme registration 和 active TextMate token projection                            | Extension/theme/TextMate services                        |
| `debuggers`                                                              | ✅ 窄声明式 adapter command discovery；不提供 VS Code Debug Extension API                                                | Extension registry / Debug service                       |
| `configurationDefaults`, `semanticTokenScopes`                           | 尚未接入；bundled manifest 中的字段不会被投影                                                                            | 后续领域 adapter                                         |
| extension JavaScript                                                     | 声明式扫描不执行；可信 `browser` 包由独立 Worker 路径执行                                                                | TS 扩展宿主                                              |
| Marketplace LSP executable                                               | 由已验证 catalog 映射并运行                                                                                              | App Server / LSP manager                                 |

User packages are read from the host-selected profile extension root, but the current Editor
Extension system has no registry, download, enable/disable, signature, or grant authority. Built-in
roots have precedence, so a profile package with the same extension ID is diagnosed and cannot
silently replace product resources. Manifest `%...%` localization placeholders and complete
Workbench theme labels fall back to the theme document or stable manifest identity when localization
placeholders cannot be resolved.
