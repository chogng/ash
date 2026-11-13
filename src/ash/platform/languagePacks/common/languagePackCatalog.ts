import { decodeBase64 as decodeBase64Buffer } from '../../../base/common/buffer.js';
import { isRecord } from '../../../base/common/types.js';
import type { LanguagePackCatalog, LanguagePackCatalogSource, LanguagePackIndexEntry } from './languagePackContract.js';
import { normalizeLocale, parseLanguagePackCatalog } from './languagePackContract.js';
import type { ILanguagePackStore } from './languagePackStore.js';

export { normalizeLocale, parseLanguagePackCatalog, parseTranslationMessages } from './languagePackContract.js';

/** Startup must remain usable when an optional language resource is missing or damaged. */
export async function resolveLanguagePackCatalog(
	locale: string,
	startupCatalogs: readonly LanguagePackCatalogSource[],
	store: Pick<ILanguagePackStore, 'read'>,
	options: { readonly preferStartupCatalogs?: boolean; } = {},
): Promise<LanguagePackCatalog> {
	let candidate = normalizeLocale(locale);
	while (candidate) {
		if (candidate === 'en') {
			break;
		}

		const packaged = startupCatalogs.find(catalog => catalog.locale.toLowerCase() === candidate.toLowerCase());
		// Development reloads must show source edits even when an older installed pack is cached.
		if (options.preferStartupCatalogs && packaged) {
			return packaged.load();
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
			return packaged.load();
		}

		const separator = candidate.lastIndexOf('-');
		candidate = separator > 0 ? candidate.slice(0, separator) : '';
	}

	const english = startupCatalogs.find(catalog => catalog.locale === 'en');
	if (!english) {
		throw new Error('The built-in English catalog is required');
	}

	return english.load();
}

export function parseLanguagePackIndexEntry(value: unknown): LanguagePackIndexEntry | undefined {
	if (!isRecord(value)
		|| typeof value.extensionId !== 'string'
		|| !/^(?:[a-z0-9_-]+(?:\.[a-z0-9_-]+)*|[a-z0-9_-]+\/[a-z0-9_-]+)(?:@[a-z0-9_-]+)?$/iu.test(value.extensionId)
		|| value.extensionId.length > 160
		|| typeof value.version !== 'string'
		|| !value.version
		|| value.version.length > 128
		|| typeof value.digest !== 'string'
		|| !/^sha256:[a-f0-9]{64}$/u.test(value.digest)) {
		return undefined;
	}

	const catalog = parseLanguagePackCatalog(value.catalog);
	if (!catalog || value.locale !== catalog.locale || catalog.locale === 'en') {
		return undefined;
	}

	return { locale: catalog.locale, extensionId: value.extensionId, version: value.version, digest: value.digest, catalog };
}

export function decodeBase64(encoded: string): string {
	return decodeBase64Buffer(encoded).toString();
}
