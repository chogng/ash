# Ash UI localization

Ash treats UI localization as a data catalog capability, separate from programming-language
packages. The product owns the catalog contract it consumes; the remote Extensions only validates,
signs, and distributes product-independent static locale payloads.

The explicit product selection in `localization/preinstalled.json` currently keeps Simplified Chinese offline.
All other language packs are installed on demand through the Rust Extensions Manager. Adding a
translation source under `extensions/` does not add it to host imports or browser package snapshots.

English and preinstalled extension catalogs are generated into `.build/desktop/localization/` and are not tracked by Git.
The source `localizationCatalogs.ts` is a stable loading entrypoint. Build and test preparation
generate the data before compilation; Vite emits one shared chunk per language, and TypeScript
includes the data modules in the host and test outputs. `pnpm localization:check` validates the
source declarations and translations without requiring or writing generated catalogs.

## Ownership

| Surface                                                              | Owner                                                                           | Contract                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Core English fallback                                                | Feature NLS declarations + shared protocol metadata                             | Always available                                                 |
| Preinstalled Simplified Chinese extension                            | `extensions/language-pack-zh-cn`                                                | Static Ash extension, available offline                          |
| Language-pack discovery, acquisition, leases, and catalog projection | `platform/languagePacks`                                                        | `ILanguagePackService`; Extensions `packageType: "localization"` |
| Locale selection and persistence                                     | `workbench/services/localization/common/locale.ts` + `browser/localeService.ts` | `ILocaleService`, local-profile `workbench.locale`               |
| Message lookup and NLS resolution                                    | `workbench/services/localization` + `src/ash/nls.ts`                            | Selected catalog → caller's English source message               |
| Remote package discovery and distribution                            | Extensions distribution                                                         | `packageType: "localization"` and `localization/package.json`    |
| Installed package lease and resource reads                           | Ash Extensions Manager                                                          | A localization capability exposes one static JSON catalog        |

The Extensions does not know Ash bundle IDs, does not execute localization packages, and does not
install them into the renderer. The App Server/Extensions Manager acquires and leases the validated
capability resource. Each client window's `platform/languagePacks` adapter reads that path-free
resource, validates the Ash catalog contract, and projects the result to its own Workbench services.

The shared service contract is `platform/languagePacks/common/languagePacks.ts`; its
Desktop and Web implementation is `browser/languagePacks.ts`. Ash retains
`common/languagePackContract.ts` for the versioned catalog data,
`common/languagePackCatalog.ts` for boundary validation and startup fallback, and
`common/languagePackStore.ts` plus `browser/languagePackStore.ts` for profile-local
startup resources. Settings derives language options from the same service-owned catalogs.
The service does not retain a second installed-package list or own package search and installation.

`getAvailableLanguages()` and gallery-extension metadata remain unimplemented because the
Extensions package summary does not expose a locale. Package names are not treated as locale IDs.
The browser adapter serves both hosts; no Node language-pack service or test-driver-only
`localizedStrings.ts` is needed by the current production call chain.

## Preinstalled language packs

Simplified Chinese is owned by [`extensions/language-pack-zh-cn`](../extensions/language-pack-zh-cn/package.json),
not the core localization directory. Its `package.json` uses `engines.ash` and
`contributes.localizations`, declaring the Ash catalog at `localization/package.json`.
It has no executable entrypoint. Domain translations live under the extension's `translations/`.
English source messages belong to their feature declarations. The generator extracts static
`localize`/`localize2` calls (including lazy data-table getters), typed localization-service calls,
same-class forwarding chains, and paired view/region localization metadata. Enum dictionaries and
dynamic-key tables declare their English originals with static `localize2(...).original` calls;
their consumers continue to translate through the appropriate window service. Approval-mode and
product Slash Command descriptions come from generated protocol metadata. English JSON dictionaries
no longer supply catalog entries; nonempty declarations in `localization/en` fail validation.

`pnpm localization:generate` validates the manifest and translations and produces the standalone
package under `.build/desktop/localization/extensions/ash.language-pack-zh-cn/`. It contains
`package.json`, the generated catalog, and the generic Extensions distribution `manifest.json`.
Optional packs generate the same standalone directory, but no TypeScript catalog module; publish
those directories through the [Extensions repository](https://github.com/chogng/extensions).
Normal extension preparation also includes that catalog in the application's bundled extension
resources. Main and browser startup consume a generated snapshot of the same extension catalog;
loading the preinstalled pack does not require an Extension Host or an App Server connection.

To create a distributable archive after generation:

```sh
cd .build/desktop/localization/extensions/ash.language-pack-zh-cn
zip -r ../../ash-language-pack-zh-cn.zip package.json manifest.json localization extension-translations
```

The bundled extension ID is `ash.language-pack-zh-cn`; distribution uses
`ash/language-pack-zh-cn`. Remote installation follows the existing signed Extensions flow.
The generated archive is a local package, not a published registry release.

## Extension translations

`contributes.localizations[].translations` declares an `ash` catalog target and optional
publisher-qualified extension targets. The preinstalled Chinese pack contains targets for Git,
Remote SSH, Media Preview and Markdown. Each extension target uses
`{ "contents": { "package": { "key": "translation" }, "bundle": { "message": "translation" } } }`.
The generated Ash catalog embeds these targets in `extensionTranslations`; the distributable
package also includes the declared JSON resources.

`MainThreadLocalization` resolves these resources from the pinned startup catalog. Manifest
`%key%` labels use the pack's `package` dictionary after the extension's own English and locale
resources. The public `vscode.l10n` API receives the `bundle` dictionary before module evaluation;
missing messages retain their English source and formatting arguments. Absent or damaged pack
resources fall back to the extension's own regional/base `l10n` bundles. The shared
`extensionNls.localizeManifest` helper owns recursive manifest substitution.

## Catalog shape

The Extensions manifest declares one locale per package. Its payload uses:

```json
{
  "schemaVersion": 1,
  "locale": "fr",
  "languageName": "French",
  "localizedLanguageName": "Français",
  "catalogVersion": "ash-1",
  "bundles": {
    "ash.settings": {
      "displayLanguage.title": "Display Language"
    }
  }
}
```

Bundle IDs and keys remain data owned by the consuming product. The Ash renderer accepts only
`catalogVersion: "ash-1"`, validates locale/name/message bounds, and ignores malformed or
product-mismatched catalogs without preventing other installed locales from loading. A future Ash
catalog contract can reject a catalog without changing the generic Extensions schema.

## Runtime behavior

`WebLanguagePacksService` starts with core English and the preinstalled language-pack extensions,
and loads additional installed Extensions catalogs through the normal capability lease. English always takes precedence. An installed update with the same package ID as a preinstalled
pack replaces its bundled catalog; a different provider cannot replace that locale. The browser
startup index records locale, package ID, version and digest alongside the validated catalog. When multiple
installed providers supply the same normalized locale, that locale is excluded from discovery and
does not overwrite saved resources; other locales remain available. Removing the duplicate provider
allows the remaining catalog to load. Unreadable resources release their leases and do not prevent
other providers from loading.

`WorkbenchLocaleService` owns the local-profile selection and saves resources before the preference.
Electron and Web resolve their startup catalog in the browser before importing Workbench
contributions. IndexedDB `ash-language-packs` stores a derived startup index; Rust extension
management owns installed packages. Electron publishes the resolved catalog to Main for system
menus. Language-pack caching and loading add no Node service or Extension Host dependency. Resolution normalizes the requested locale, tries an exact
match, then successively less specific locales, and finally built-in English. Missing, damaged or
incompatible language resources do not block startup. The preference remains saved so reinstalling a
valid pack can restore it on a later startup. `WorkbenchLocalizationService` uses the same startup NLS
snapshot as direct `nls.ts` calls. Missing messages use the caller's English source message.

The Command Palette provides **Configure Display Language** and **Clear Display Language Preference**.
The picker obtains installed locales through `ILanguagePackService.getInstalledLanguages()` and searches localization packages directly through `IExtensionManagementService` as the user types.
Selecting a package installs it through Extension Management, refreshes the language catalogs, and selects its new locale; the Extensions entry opens the package
browser when the user wants to browse. Clearing the preference removes `workbench.locale` from the
local profile and selects English for the next startup. Changing the preference leaves the current
interface unchanged and offers to restart now or later. After a successful installed-package refresh, the index is replaced atomically; uninstalled,
conflicting or damaged providers are removed. Uninstalling an update restores the bundled version
for a preinstalled locale, otherwise the next startup falls back to English. An unavailable backend
preserves the last validated startup index. The running window keeps its original UI and extension
translation snapshot until restart.

The [French example package](../localization/examples/fr/manifest.json) uses the Ash `ash-1` catalog
contract and translates a small part of the shell and display-language settings. Its static resource
is [localization/package.json](../localization/examples/fr/localization/package.json). The example is
not published; installation uses the existing signed Extensions distribution flow. It does not adapt
VS Code language-pack payloads.

The [Desktop language-pack smoke test](../test/smoke/areas/windows/display-language.spec.ts) installs a
real Simplified Chinese ZIP through Extensions, updates the exact installation to a second release,
and uninstalls it before checking that a restart restores the preinstalled UI and Git command labels.
Its isolated signed HTTPS source serves TUF metadata and both releases. The scenario asserts successful
HTTPS archive downloads with their actual lengths; the production Rust manager
verifies and extracts the packages, persists installations and serves localization capability resources.
The fixture never seeds the source cache, installation records or browser language index. Its test CA is
pinned only by the isolated product-services configuration, with TLS verification enabled and no system
trust changes. No public Marketplace upload is required. Separate scenarios cover
missing and damaged indexes, while the installation scenario also checks English fallback for an absent
message. No production Node language-pack path is involved.

The selected catalog is consumed by the Workbench menu/action layer, core View Container and
ViewPane titles, CompositeBar overflow labels, region accessibility labels, Settings navigation,
and Extensions discovery chrome. Domain-specific editor welcome text, chat content, terminal
profile names, diagnostics, and arbitrary server/user data remain English or source-provided until
their owners add stable bundle/key metadata. This is an explicit migration boundary, not a fallback
from Extensions.

The interaction follows the same product shape as VS Code: English is always available, additional
display languages are installed as Extensions language packs, and the selected display language is
persisted by the product. The App Server remains locale-neutral because it serves multiple clients;
Desktop and browser profiles store their own display-language preference. Worker and Rust/V8 Extension Hosts receive language and translation bundles in the existing
per-window initialization snapshot; no global App Server language is set. The POSIX `locale` environment variable mentioned in the
App Server terminal boundary is process environment inheritance, not the UI `workbench.locale`
selection. See [VS Code Display Language](https://code.visualstudio.com/docs/configure/locales) for
the reference user experience.

## Chromium display-language resources

Desktop packaging retains English and the locales selected by `localization/preinstalled.json`.
The filter runs on the extracted official Electron distribution before code signing. ICU data
remains available for international text and formatting. Other Ash display-language packs are
static product catalogs installed by Rust; they do not modify Chromium resources inside the
signed application. Chromium UI uses its available fallback language when the system locale is
not shipped.

A signed registry can be checked through the production Rust manager without launching an
extension process. Use an empty temporary state directory; the check installs the partial French
package, reads its catalog through a lease, then releases the lease and uninstalls the package:

```bash
./scripts/.venv/bin/python -B scripts/cargo.py run -p ash-core-plugins \
  --example localization_distribution_smoke -- \
  https://chogng.github.io/extensions/ \
  resources/product-services/extensions-root.json /absolute/path/to/empty-test-state
```

The first argument also accepts a locally signed distribution directory for release rehearsals.
