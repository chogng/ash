import { decodeBase64 as decodeBase64Buffer } from "../../../base/common/buffer.js";
import { isRecord } from "../../../base/common/types.js";
import type { LanguagePackCatalog } from "./languagePacksService.js";
import { ASH_LOCALIZATION_CATALOG_VERSION } from "./languagePackContract.js";
import type { ILanguagePackStore } from "./languagePackStore.js";

export function normalizeLocale(value: string): string {
	const parts = value.trim().replaceAll("_", "-").split("-");
	if (parts.length === 0 || !parts[0] || parts.some((part) => !/^[A-Za-z0-9]+$/u.test(part))) return "";
	return parts.map((part, index) => index === 0 ? part.toLowerCase() : part.length === 2 || part.length === 3 ? part.toUpperCase() : part).join("-");
}

/** Startup must remain usable when an optional language resource is missing or damaged. */
export async function resolveLanguagePackCatalog(locale: string, builtins: readonly LanguagePackCatalog[], store: ILanguagePackStore): Promise<LanguagePackCatalog> {
	let candidate = normalizeLocale(locale);
	while (candidate) {
		const builtin = builtins.find(catalog => catalog.locale.toLowerCase() === candidate.toLowerCase());
		if (builtin) { return builtin; }
		try {
			const catalog = await store.read(candidate);
			if (catalog) { return catalog; }
		} catch {
			// Keep the preference so reinstalling the pack can restore it on a later startup.
		}
		const separator = candidate.lastIndexOf("-");
		candidate = separator > 0 ? candidate.slice(0, separator) : "";
	}
	const english = builtins.find(catalog => catalog.locale === "en");
	if (!english) { throw new Error("The built-in English catalog is required"); }
	return english;
}

/** Validates the product-specific static resource after Extensions acquisition. */
export function parseLanguagePackCatalog(value: unknown): LanguagePackCatalog | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = value;
	if (candidate.schemaVersion !== 1 || typeof candidate.locale !== "string" || typeof candidate.languageName !== "string" || typeof candidate.localizedLanguageName !== "string" || candidate.catalogVersion !== ASH_LOCALIZATION_CATALOG_VERSION || !isRecord(candidate.bundles)) return undefined;
	const locale = normalizeLocale(candidate.locale);
	if (!locale || !candidate.languageName.trim() || !candidate.localizedLanguageName.trim() || candidate.languageName.length > 128 || candidate.localizedLanguageName.length > 128) return undefined;
	const bundles: Record<string, Record<string, string>> = {};
	const bundleEntries = Object.entries(candidate.bundles);
	if (bundleEntries.length === 0 || bundleEntries.length > 2048) return undefined;
	for (const [bundle, messages] of bundleEntries) {
		if (!bundle.trim() || bundle.length > 256 || !isRecord(messages)) return undefined;
		const normalizedMessages: Record<string, string> = {};
		const messageEntries = Object.entries(messages);
		if (messageEntries.length === 0 || messageEntries.length > 10000) return undefined;
		for (const [key, message] of messageEntries) {
			if (!key.trim() || key.length > 512 || typeof message !== "string" || message.length > 64 * 1024) return undefined;
			normalizedMessages[key] = message;
		}
		bundles[bundle] = normalizedMessages;
	}
	return {
		schemaVersion: 1,
		locale,
		languageName: candidate.languageName,
		localizedLanguageName: candidate.localizedLanguageName,
		catalogVersion: candidate.catalogVersion,
		bundles,
	};
}

export function decodeBase64(encoded: string): string {
	return decodeBase64Buffer(encoded).toString();
}
