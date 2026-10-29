import { decodeBase64 as decodeBase64Buffer } from '../../../base/common/buffer.js';
import { isRecord } from '../../../base/common/types.js';
import type { LanguagePackCatalog } from './languagePackContract.js';
import { ASH_LOCALIZATION_CATALOG_VERSION } from './languagePackContract.js';
import type { ILanguagePackStore } from './languagePackStore.js';
import type { LanguagePackIndexEntry } from './languagePackContract.js';

export function normalizeLocale(value: string): string {
	const parts = value.trim().replaceAll('_', '-').split('-');
	if (parts.length === 0 || !parts[0] || parts.some(part => !/^[A-Za-z0-9]+$/u.test(part))) return '';
	return parts
		.map((part, index) =>
			index === 0 ? part.toLowerCase() : part.length === 2 || part.length === 3 ? part.toUpperCase() : part,
		)
		.join('-');
}

/** Startup must remain usable when an optional language resource is missing or damaged. */
export async function resolveLanguagePackCatalog(
	locale: string,
	startupCatalogs: readonly LanguagePackCatalog[],
	store: Pick<ILanguagePackStore, 'read'>,
	options: { readonly preferStartupCatalogs?: boolean } = {},
): Promise<LanguagePackCatalog> {
	let candidate = normalizeLocale(locale);
	while (candidate) {
		if (candidate === 'en') {
			break;
		}
		const packaged = startupCatalogs.find(catalog => catalog.locale.toLowerCase() === candidate.toLowerCase());
		// Source catalogs must win during development so a reload can show edited
		// translations even when the browser has saved an older installed pack.
		if (options.preferStartupCatalogs && packaged) {
			return packaged;
		}
		try {
			const catalog = await store.read(candidate);
			if (catalog) {
				return catalog;
			}
		} catch {
			// Keep the preference so reinstalling the pack can restore it on a later startup.
		}
		if (packaged) {
			return packaged;
		}
		const separator = candidate.lastIndexOf('-');
		candidate = separator > 0 ? candidate.slice(0, separator) : '';
	}
	const english = startupCatalogs.find(catalog => catalog.locale === 'en');
	if (!english) {
		throw new Error('The built-in English catalog is required');
	}
	return english;
}

/** Validates the product-specific static resource after Extensions acquisition. */
export function parseLanguagePackCatalog(value: unknown): LanguagePackCatalog | undefined {
	if (!isRecord(value)) return undefined;
	const candidate = value;
	if (
		candidate.schemaVersion !== 1 ||
		typeof candidate.locale !== 'string' ||
		typeof candidate.languageName !== 'string' ||
		typeof candidate.localizedLanguageName !== 'string' ||
		candidate.catalogVersion !== ASH_LOCALIZATION_CATALOG_VERSION ||
		!isRecord(candidate.bundles)
	)
		return undefined;
	const locale = normalizeLocale(candidate.locale);
	if (
		!locale ||
		!candidate.languageName.trim() ||
		!candidate.localizedLanguageName.trim() ||
		candidate.languageName.length > 128 ||
		candidate.localizedLanguageName.length > 128
	)
		return undefined;
	const bundles: Record<string, Record<string, string>> = {};
	const bundleEntries = Object.entries(candidate.bundles);
	if (bundleEntries.length === 0 || bundleEntries.length > 2048) return undefined;
	for (const [bundle, messages] of bundleEntries) {
		if (!bundle.trim() || bundle.length > 256 || !isRecord(messages)) return undefined;
		const normalizedMessages: Record<string, string> = {};
		const messageEntries = Object.entries(messages);
		if (messageEntries.length === 0 || messageEntries.length > 10000) return undefined;
		for (const [key, message] of messageEntries) {
			if (!key.trim() || key.length > 512 || typeof message !== 'string' || message.length > 64 * 1024)
				return undefined;
			normalizedMessages[key] = message;
		}
		bundles[bundle] = normalizedMessages;
	}
	const extensionTranslations: Record<
		string,
		{ package: Readonly<Record<string, string>>; bundle: Readonly<Record<string, string>> }
	> = {};
	if (candidate.extensionTranslations !== undefined) {
		if (!isRecord(candidate.extensionTranslations) || Object.keys(candidate.extensionTranslations).length > 2048) {
			return undefined;
		}
		for (const [id, translations] of Object.entries(candidate.extensionTranslations)) {
			if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/iu.test(id) || !isRecord(translations)) {
				return undefined;
			}
			const packageMessages = parseTranslationMessages(translations.package);
			const codeMessages = parseTranslationMessages(translations.bundle);
			if (!packageMessages || !codeMessages || Object.hasOwn(extensionTranslations, id.toLowerCase())) {
				return undefined;
			}
			extensionTranslations[id.toLowerCase()] = { package: packageMessages, bundle: codeMessages };
		}
	}
	return {
		schemaVersion: 1,
		locale,
		languageName: candidate.languageName,
		localizedLanguageName: candidate.localizedLanguageName,
		catalogVersion: candidate.catalogVersion,
		bundles,
		...(candidate.extensionTranslations === undefined ? {} : { extensionTranslations }),
	};
}

export function parseTranslationMessages(value: unknown): Readonly<Record<string, string>> | undefined {
	if (!isRecord(value) || Object.keys(value).length > 10000) {
		return undefined;
	}
	const messages: Record<string, string> = Object.create(null);
	for (const [key, message] of Object.entries(value)) {
		if (!key || key.length > 1024 || typeof message !== 'string' || message.length > 64 * 1024) {
			return undefined;
		}
		messages[key] = message;
	}
	return messages;
}

export function parseLanguagePackIndexEntry(value: unknown): LanguagePackIndexEntry | undefined {
	if (
		!isRecord(value) ||
		typeof value.extensionId !== 'string' ||
		!/^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|[a-z0-9_-]+\/[a-z0-9_-]+)(?:@[a-z0-9_-]+)?$/iu.test(value.extensionId) ||
		value.extensionId.length > 160 ||
		typeof value.version !== 'string' ||
		!value.version ||
		value.version.length > 128 ||
		typeof value.digest !== 'string' ||
		!/^sha256:[a-f0-9]{64}$/u.test(value.digest)
	) {
		return undefined;
	}
	const catalog = parseLanguagePackCatalog(value.catalog);
	if (!catalog || value.locale !== catalog.locale || catalog.locale === 'en') {
		return undefined;
	}
	return {
		locale: catalog.locale,
		extensionId: value.extensionId,
		version: value.version,
		digest: value.digest,
		catalog,
	};
}

export function decodeBase64(encoded: string): string {
	return decodeBase64Buffer(encoded).toString();
}
