/** Version of the static catalog contract consumed by Ash clients. */
export const ASH_LOCALIZATION_CATALOG_VERSION = 'ash-1';

export interface LanguagePackCatalog {
	readonly schemaVersion: 1;
	readonly locale: string;
	readonly languageName: string;
	readonly localizedLanguageName: string;
	readonly catalogVersion: string;
	readonly bundles: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly extensionTranslations?: Readonly<Record<string, { readonly package: Readonly<Record<string, string>>; readonly bundle: Readonly<Record<string, string>> }>>;
}

export interface PreinstalledLanguagePack {
	readonly id: string;
	readonly version: string;
	readonly displayName: string;
	readonly description: string;
	readonly catalog: LanguagePackCatalog;
}

/** A derived startup resource tied to the installed package that supplied it. */
export interface LanguagePackIndexEntry {
	readonly locale: string;
	readonly extensionId: string;
	readonly version: string;
	readonly digest: string;
	readonly catalog: LanguagePackCatalog;
}
