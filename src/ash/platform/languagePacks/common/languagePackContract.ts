/** Version of the static catalog contract consumed by Ash clients. */
export const ASH_LOCALIZATION_CATALOG_VERSION = "ash-1";

export interface LanguagePackCatalog {
	readonly schemaVersion: 1;
	readonly locale: string;
	readonly languageName: string;
	readonly localizedLanguageName: string;
	readonly catalogVersion: string;
	readonly bundles: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
