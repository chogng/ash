# Built-in extensions

> This README owns the repository package-set and distribution contract. The cross-layer runtime,
> trust, refresh, and evolution contract is maintained in
> [`docs/editor-extensions.md`](../docs/editor-extensions.md); the Rust catalog implementation is
> documented in [`ash-rs/extensions/README.md`](../ash-rs/extensions/README.md).

This directory contains static extension packages shipped with Ash during development. Packaging
places the same directory under `ash-resources/extensions/`.

Except for this README and `BUILD.bazel`, each direct child must be a package directory with a
`package.json`. TextMate packages may put raw JSON or PLIST grammars below the package and reference
them from `contributes.grammars[].path`.
Built-in packages are declarative resources only; this directory is not an extension JavaScript
runtime or a workspace plugin directory.

## Source and distribution boundary

This directory is a runtime input, not a download endpoint. Built-in packages committed here are
copied into `ash-resources/extensions/` during development and production packaging. Ash reads
that trusted package directory through `ash-extensions`; App is only a future consumer extension
point. A running application does not authenticate to a Git repository to load built-in extensions.

If the package set later moves to a shared `ash-extension-packs` repository, that repository may
be private and may own upstream pinning, license/notice preservation, validation, and CI builds.
It must publish versioned extension artifacts for Ash and App to consume during their build or
release process. A running application must consume the packaged artifact or extracted extension
directory, never Git credentials or an unversioned repository checkout.

The bundled packages are derived from `microsoft/vscode` and retain their package-level
`NOTICE.md` provenance. The canonical upstream MIT license copy is
[`third_party/vscode/LICENSE.txt`](../third_party/vscode/LICENSE.txt); both production and Desktop
development packaging place it at `ash-resources/licenses/vscode/LICENSE.txt` alongside the
extension packages.

User-installed extensions are a separate profile-level root. They require an explicit registry or
release distribution mechanism and must not be mixed with these built-in resources.

## Bundled packages

The current declarative pack contains the following package directories:

- `css`, `html`, `javascript`, `json`, `markdown-basics`, `python`, `rust`, `shellscript`, `sql`,
  `typescript-basics`, `xml`, and `yaml` provide language IDs, file associations, language
  configuration, TextMate grammars, and—where upstream provides them—snippets.
- `theme-seti` provides the Seti file icon document, font, and third-party notices.
- `theme-defaults` provides four self-contained VS Code-derived color-theme documents. Themes that
  rely on VS Code `include` composition are intentionally excluded until the packaging pipeline
  can flatten them deterministically.

The manifest is the only source of contribution metadata. `AppServerExtensionService` receives
Rust-validated package resources and projects languages/configuration/snippets/grammars/themes/
debuggers into their Workbench-owned registries; the browser TextMate runtime never imports package
files directly. Theme documents register selectable Workbench color themes and provide the active
TextMate token scope rules.

Supported declarative fields are deliberately narrower than a VS Code extension host:

| Contribution | Current state | Owner |
| --- | --- | --- |
| `languages`, file/first-line associations, `language-configuration.json` | ✅ loaded and registered | Editor language registry/configuration |
| `snippets` | ✅ 有 prefix 的 snippet 注册为 completion；file template 可通过 `New File from Template` 创建 untitled editor | Editor language completion / extension template registry |
| `grammars` | ✅ loaded through Rust resource APIs and TextMate catalog snapshots | Workbench TextMate service |
| `embeddedLanguages`, `tokenTypes`, bracket scope metadata | ✅ validated, transported, and projected to Stanza token language/type/bracket metadata | TextMate adapter |
| `iconThemes` | Loaded from package resources; supports font and SVG/PNG file icons, light variants, and `workbench.iconTheme` selection | Workbench theme service |
| `themes` | ✅ 严格解析、版本化 catalog、Workbench theme registration 和 active TextMate token projection | Extension/theme/TextMate services |
| `debuggers` | ✅ 窄声明式 adapter command discovery；不提供 VS Code Debug Extension API | Extension registry / Debug service |
| `configurationDefaults`, `semanticTokenScopes` | 尚未接入；bundled manifest 中的字段不会被投影 | 后续领域 adapter |
| extension JavaScript, LSP server declarations | ❌ 不执行 | 独立信任与 runtime 评审 |

User packages are read from the host-selected profile extension root, but the current Editor
Extension system has no registry, download, enable/disable, signature, or grant authority. Built-in
roots have precedence, so a profile package with the same extension ID is diagnosed and cannot
silently replace product resources. Manifest `%...%` localization placeholders and complete
Workbench theme labels fall back to the theme document or stable manifest identity when localization
placeholders cannot be resolved.
