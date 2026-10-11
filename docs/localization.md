# Ash UI localization

Ash treats UI localization as a data catalog capability, separate from programming-language
packages. The product owns the catalog contract it consumes; the remote Extensions only validates,
signs, and distributes product-independent static locale payloads.

English and preinstalled extension catalogs are generated into `.build/desktop/localization/` and are not tracked by Git.
The source `localizationCatalogs.ts` is a stable loading entrypoint. Build and test preparation
generate the data before compilation; Vite emits one shared chunk per language, and TypeScript
includes the data modules in the host and test outputs. `pnpm localization:check` validates the
source declarations and translations without requiring or writing generated catalogs.

## Ownership

| Surface                                                              | Owner                                                                           | Contract                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Core English fallback | `localization/en` + feature NLS declarations | Always available |
| Preinstalled Simplified Chinese extension | `extensions/language-pack-zh-cn` | Static Ash extension, available offline |
| Language-pack discovery, acquisition, leases, and catalog projection | `platform/languagePacks`                                                        | `ILanguagePackService`; Extensions `packageType: "localization"` |
| Locale selection and persistence                                     | `workbench/services/localization/common/locale.ts` + `browser/localeService.ts` | `ILocaleService`, local-profile `workbench.locale`                |
| Message lookup and NLS resolution                                    | `workbench/services/localization` + `src/ash/nls.ts`                            | Selected catalog → caller's English source message                |
| Remote package discovery and distribution                            | Extensions distribution                                                        | `packageType: "localization"` and `localization/package.json`     |
| Installed package lease and resource reads                           | Ash Extensions Manager                                                         | A localization capability exposes one static JSON catalog         |

The Extensions does not know Ash bundle IDs, does not execute localization packages, and does not
install them into the renderer. The App Server/Extensions Manager acquires and leases the validated
capability resource. Each client window's `platform/languagePacks` adapter reads that path-free
resource, validates the Ash catalog contract, and projects the result to its own Workbench services.

## Preinstalled language packs

Simplified Chinese is owned by [`extensions/language-pack-zh-cn`](../extensions/language-pack-zh-cn/package.json),
not the core localization directory. Its `package.json` uses `engines.ash` and
`contributes.localizations`, declaring the Ash catalog at `localization/package.json`.
It has no executable entrypoint. Domain translations live under the extension's `translations/`.
English source messages remain in feature declarations and `localization/en` as the core fallback.

`pnpm localization:generate` validates the manifest and translations and produces the standalone
package under `.build/desktop/localization/extensions/ash.language-pack-zh-cn/`. It contains
`package.json`, the generated catalog, and the generic Extensions distribution `manifest.json`.
Normal extension preparation also includes that catalog in the application's bundled extension
resources. Main and browser startup consume a generated snapshot of the same extension catalog;
loading the preinstalled pack does not require an Extension Host or an App Server connection.

To create a distributable archive after generation:

```sh
cd .build/desktop/localization/extensions/ash.language-pack-zh-cn
zip -r ../../ash-language-pack-zh-cn.zip package.json manifest.json localization
```

The bundled extension ID is `ash.language-pack-zh-cn`; distribution uses
`ash/language-pack-zh-cn`. Remote installation follows the existing signed Extensions flow.
The generated archive is a local package, not a published registry release.

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

`ExtensionsLanguagePackService` starts with core English and the preinstalled language-pack extensions,
and loads additional installed Extensions catalogs through the normal capability lease. Core and
preinstalled locales take precedence. Their provenance remains distinct in the language-pack service. When multiple
installed providers supply the same normalized locale, that locale is excluded from discovery and
does not overwrite saved resources; other locales remain available. Removing the duplicate provider
allows the remaining catalog to load. Unreadable resources release their leases and do not prevent
other providers from loading.

`WorkbenchLocaleService` owns the local-profile selection and saves resources before the preference.
Electron Main resolves one startup catalog for all windows and system menus; Web resolves its catalog
before importing Workbench contributions. Resolution normalizes the requested locale, tries an exact
match, then successively less specific locales, and finally built-in English. Missing, damaged or
incompatible language resources do not block startup. The preference remains saved so reinstalling a
valid pack can restore it on a later startup. `WorkbenchLocalizationService` uses the same startup NLS
snapshot as direct `nls.ts` calls. Missing messages use the caller's English source message.

The Command Palette provides **Configure Display Language** and **Clear Display Language Preference**.
The picker lists available locales and searches Extensions localization packages as the user types.
Selecting a package installs it and selects its new locale; the Extensions entry opens the package
browser when the user wants to browse. Clearing the preference removes `workbench.locale` from the
local profile and selects English for the next startup. Changing the preference leaves the current
interface unchanged and offers to restart now or later. Uninstalling a package keeps its saved startup
resource usable, independently of backend availability.

The [French example package](../localization/examples/fr/manifest.json) uses the Ash `ash-1` catalog
contract and translates a small part of the shell and display-language settings. Its static resource
is [localization/package.json](../localization/examples/fr/localization/package.json). The example is
not published; installation uses the existing signed Extensions distribution flow. It does not adapt
VS Code language-pack payloads.

The selected catalog is consumed by the Workbench menu/action layer, core View Container and
ViewPane titles, CompositeBar overflow labels, region accessibility labels, Settings navigation,
and Extensions discovery chrome. Domain-specific editor welcome text, chat content, terminal
profile names, diagnostics, and arbitrary server/user data remain English or source-provided until
their owners add stable bundle/key metadata. This is an explicit migration boundary, not a fallback
from Extensions.

The interaction follows the same product shape as VS Code: English is always available, additional
display languages are installed as Extensions language packs, and the selected display language is
persisted by the product. The App Server remains locale-neutral because it serves multiple clients;
Desktop and browser profiles store their own display-language preference. If a
future server-side Extension Host needs NLS, its locale must be supplied per connection/process and
must not become global App Server state. The POSIX `locale` environment variable mentioned in the
App Server terminal boundary is process environment inheritance, not the UI `workbench.locale`
selection. See [VS Code Display Language](https://code.visualstudio.com/docs/configure/locales) for
the reference user experience.
