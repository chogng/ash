# Ash UI localization

Ash treats UI localization as a data catalog capability, separate from programming-language
packages. The product owns the catalog contract it consumes; the remote Marketplace only validates,
signs, and distributes product-independent static locale payloads.

## Ownership

| Surface | Owner | Contract |
| --- | --- | --- |
| Built-in English and Simplified Chinese | `workbench/services/localization/common/localizationCatalogs.ts` | Always available without Marketplace access |
| Language-pack discovery, acquisition, leases, and catalog projection | `platform/languagePacks` | `ILanguagePackService`; Marketplace `packageType: "localization"` |
| Locale selection and persistence | `workbench/services/localization/common/locale.ts` | `ILocaleService`, client/window-local `workbench.locale` |
| Message lookup and NLS projection | `workbench/services/localization` + `app-ts/src/ash/nls.ts` | Selected catalog → English catalog → caller fallback |
| Remote package discovery and distribution | `../marketplace` | `packageType: "localization"` and `localization/package.json` |
| Installed package lease and resource reads | Ash Marketplace Manager | A localization capability exposes one static JSON catalog |

The Marketplace does not know Ash bundle IDs, does not execute localization packages, and does not
install them into the renderer. The App Server/Marketplace Manager acquires and leases the validated
capability resource. Each client window's `platform/languagePacks` adapter reads that path-free
resource, validates the Ash catalog contract, and projects the result to its own Workbench services.

## Catalog shape

The Marketplace manifest declares one locale per package. Its payload uses:

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
catalog contract can reject a catalog without changing the generic Marketplace schema.

## Runtime behavior

`MarketplaceLanguagePackService` starts with the built-in catalogs and loads installed Marketplace
catalogs through the normal capability lease. `WorkbenchLocaleService` owns the client/window-local
selection and persistence. `WorkbenchLocalizationService` owns lookup and projects it into the
low-level `nls.ts` resolver used by platform actions and Workbench chrome. Locale resolution prefers
an exact match, then a case-insensitive match, then a base language, and finally English. Missing
messages never erase the UI.

The `workbench/contrib/localization` Settings contribution provides the locale-selection vertical
slice: it consumes `ILanguagePackService` and `ILocaleService`, lists built-in locales, discovers
`localization` packages, installs a selected package, refreshes the client projection after package
lifecycle events, shows installed state, and persists `workbench.locale`. Preferences only hosts the
section; it no longer owns Marketplace or catalog reads.

The current built-in catalog is consumed by the Workbench menu/action layer, core View Container and
ViewPane titles, CompositeBar overflow labels, region accessibility labels, Settings navigation,
and Marketplace discovery chrome. Domain-specific editor welcome text, chat content, terminal
profile names, diagnostics, and arbitrary server/user data remain English or source-provided until
their owners add stable bundle/key metadata. This is an explicit migration boundary, not a fallback
from Marketplace.

The interaction follows the same product shape as VS Code: English is always available, additional
display languages are installed as Marketplace language packs, and the selected display language is
persisted by the product. The App Server remains locale-neutral because it serves multiple clients;
Desktop, a browser client, TUI, and app connections select their locale independently. If a
future server-side Extension Host needs NLS, its locale must be supplied per connection/process and
must not become global App Server state. The POSIX `locale` environment variable mentioned in the
App Server terminal boundary is process environment inheritance, not the UI `workbench.locale`
selection. See [VS Code Display Language](https://code.visualstudio.com/docs/configure/locales) for
the reference user experience.
