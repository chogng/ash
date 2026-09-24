import type { Event } from "../../../base/common/event.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";

export type LocaleId = string;

export interface LanguagePackCatalog {
	readonly schemaVersion: 1;
	readonly locale: LocaleId;
	readonly languageName: string;
	readonly localizedLanguageName: string;
	readonly catalogVersion: string;
	readonly bundles: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface LanguagePackInfo {
	readonly locale: LocaleId;
	readonly languageName: string;
	readonly localizedLanguageName: string;
	readonly source: "builtin" | "marketplace";
}

export interface LanguagePackPackage {
	readonly id: string;
	readonly version: string;
	readonly displayName: string;
	readonly description: string;
	readonly installed: boolean;
}

/**
 * Acquires and projects display-language packs for one client window.
 *
 * Implementations own package discovery, capability leases, resource decoding,
 * and catalog validation. Locale selection and message lookup consume this
 * contract without depending on Marketplace transport details.
 */
export interface ILanguagePackService {
	readonly onDidChange: Event<void>;
	readonly whenReady: Promise<void>;
	readonly catalogs: readonly LanguagePackCatalog[];
	readonly availableLocales: readonly LanguagePackInfo[];
	readonly installedPackages: readonly LanguagePackPackage[];

	search(query: string, limit?: number): Promise<readonly LanguagePackPackage[]>;
	install(packageId: string, version?: string): Promise<void>;
	refresh(): Promise<void>;
}

export const ILanguagePackService = createServiceIdentifier<ILanguagePackService>("languagePackService");
