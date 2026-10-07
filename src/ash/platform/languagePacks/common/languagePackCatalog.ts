import { decodeBase64 as decodeBase64Buffer } from "../../../base/common/buffer.js";
import { isRecord } from "../../../base/common/types.js";
import type { LanguagePackCatalog } from "./languagePacksService.js";
import { ASH_LOCALIZATION_CATALOG_VERSION } from "./languagePackContract.js";

export function normalizeLocale(value: string): string {
	const parts = value.trim().replaceAll("_", "-").split("-");
	if (parts.length === 0 || !parts[0] || parts.some((part) => !/^[A-Za-z0-9]+$/u.test(part))) return "";
	return parts.map((part, index) => index === 0 ? part.toLowerCase() : part.length === 2 || part.length === 3 ? part.toUpperCase() : part).join("-");
}

/** Validates the product-specific static resource after Marketplace acquisition. */
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
