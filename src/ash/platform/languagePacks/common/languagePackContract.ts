/** Version of the static catalog contract consumed by Ash clients. */
export const ASH_LOCALIZATION_CATALOG_VERSION = 'ash-1';

export interface LanguagePackCatalog {
	readonly schemaVersion: 1;
	readonly locale: string;
	readonly languageName: string;
	readonly localizedLanguageName: string;
	readonly catalogVersion: string;
	readonly bundles: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly extensionTranslations?: Readonly<Record<string, { readonly package: Readonly<Record<string, string>>; readonly bundle: Readonly<Record<string, string>>; }>>;
}

export type LanguagePackMetadata = Pick<LanguagePackCatalog, 'locale' | 'languageName' | 'localizedLanguageName'>;

/** Bundled language metadata can be used without loading its message tables. */
export interface LanguagePackCatalogSource extends LanguagePackMetadata {
	load(): Promise<LanguagePackCatalog>;
}

export interface PreinstalledLanguagePack {
	readonly id: string;
	readonly version: string;
	readonly displayName: string;
	readonly description: string;
	readonly catalog: LanguagePackCatalogSource;
}

/** A derived startup resource tied to the installed package that supplied it. */
export interface LanguagePackIndexEntry {
	readonly locale: string;
	readonly extensionId: string;
	readonly version: string;
	readonly digest: string;
	readonly catalog: LanguagePackCatalog;
}

export function normalizeLocale(value: string): string {
	const parts = value.trim().replaceAll('_', '-').split('-');
	if (parts.length === 0 || !parts[0] || parts.some(part => !/^[A-Za-z0-9]+$/u.test(part))) {
		return '';
	}

	return parts.map((part, index) => index === 0
		? part.toLowerCase()
		: part.length === 2 || part.length === 3 ? part.toUpperCase() : part
	).join('-');
}

class LanguagePackValidationError extends TypeError {
	constructor(path: string, constraint: string) {
		super(`${path}: ${constraint}`);
	}
}

/** Reads optional installed resources without making a damaged pack fatal to startup. */
export function parseLanguagePackCatalog(value: unknown): LanguagePackCatalog | undefined {
	try {
		return validateLanguagePackCatalog(value);
	} catch (error) {
		if (error instanceof LanguagePackValidationError) {
			return undefined;
		}
		throw error;
	}
}

/** Applies the same catalog contract to generated assets and untrusted runtime resources. */
export function validateLanguagePackCatalog(value: unknown): LanguagePackCatalog {
	if (!isRecord(value)) {
		throw new LanguagePackValidationError('catalog', 'expected an object');
	}
	if (value.schemaVersion !== 1) {
		throw new LanguagePackValidationError('schemaVersion', 'expected 1');
	}
	if (value.catalogVersion !== ASH_LOCALIZATION_CATALOG_VERSION) {
		throw new LanguagePackValidationError('catalogVersion', `expected ${ASH_LOCALIZATION_CATALOG_VERSION}`);
	}
	if (typeof value.locale !== 'string' || !normalizeLocale(value.locale)) {
		throw new LanguagePackValidationError('locale', 'expected a valid locale');
	}
	if (typeof value.languageName !== 'string' || !value.languageName.trim() || value.languageName.length > 128) {
		throw new LanguagePackValidationError('languageName', 'expected non-empty text of at most 128 characters');
	}
	if (typeof value.localizedLanguageName !== 'string' || !value.localizedLanguageName.trim() || value.localizedLanguageName.length > 128) {
		throw new LanguagePackValidationError('localizedLanguageName', 'expected non-empty text of at most 128 characters');
	}
	if (!isRecord(value.bundles)) {
		throw new LanguagePackValidationError('bundles', 'expected an object');
	}

	const bundles: Record<string, Record<string, string>> = {};
	const bundleEntries = Object.entries(value.bundles);
	if (bundleEntries.length === 0 || bundleEntries.length > 2048) {
		throw new LanguagePackValidationError('bundles', `expected 1–2048 bundles (received ${bundleEntries.length})`);
	}

	for (const [bundle, messages] of bundleEntries) {
		const path = `bundles[${JSON.stringify(bundle)}]`;
		if (!bundle.trim() || bundle.length > 256) {
			throw new LanguagePackValidationError(path, 'expected a non-empty bundle name of at most 256 characters');
		}
		if (!isRecord(messages)) {
			throw new LanguagePackValidationError(path, 'expected a message object');
		}

		const normalizedMessages: Record<string, string> = {};
		const messageEntries = Object.entries(messages);
		// Allow product catalog growth beyond 10,000 messages while bounding untrusted input.
		const maxMessages = 100_000;
		if (messageEntries.length === 0 || messageEntries.length > maxMessages) {
			throw new LanguagePackValidationError(path, `expected 1–${maxMessages} messages (received ${messageEntries.length})`);
		}

		for (const [key, message] of messageEntries) {
			const messagePath = `${path}[${JSON.stringify(key)}]`;
			if (!key.trim() || key.length > 512) {
				throw new LanguagePackValidationError(messagePath, 'expected a non-empty message key of at most 512 characters');
			}
			if (typeof message !== 'string' || message.length > 64 * 1024) {
				throw new LanguagePackValidationError(messagePath, 'expected a string of at most 65536 characters');
			}
			normalizedMessages[key] = message;
		}
		bundles[bundle] = normalizedMessages;
	}

	const extensionTranslations: Record<string, {
		package: Readonly<Record<string, string>>;
		bundle: Readonly<Record<string, string>>;
	}> = {};
	if (value.extensionTranslations !== undefined) {
		if (!isRecord(value.extensionTranslations) || Object.keys(value.extensionTranslations).length > 2048) {
			throw new LanguagePackValidationError('extensionTranslations', 'expected an object with at most 2048 extensions');
		}

		for (const [id, translations] of Object.entries(value.extensionTranslations)) {
			const path = `extensionTranslations[${JSON.stringify(id)}]`;
			if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/iu.test(id) || !isRecord(translations)) {
				throw new LanguagePackValidationError(path, 'expected a publisher.name extension ID and a translation object');
			}
			if (Object.hasOwn(extensionTranslations, id.toLowerCase())) {
				throw new LanguagePackValidationError(path, 'duplicate extension ID');
			}

			extensionTranslations[id.toLowerCase()] = {
				package: validateTranslationMessages(translations.package, `${path}.package`),
				bundle: validateTranslationMessages(translations.bundle, `${path}.bundle`),
			};
		}
	}

	return {
		schemaVersion: 1,
		locale: normalizeLocale(value.locale),
		languageName: value.languageName,
		localizedLanguageName: value.localizedLanguageName,
		catalogVersion: value.catalogVersion,
		bundles,
		...(value.extensionTranslations === undefined ? {} : { extensionTranslations }),
	};
}

export function parseTranslationMessages(value: unknown): Readonly<Record<string, string>> | undefined {
	try {
		return validateTranslationMessages(value, 'translations');
	} catch (error) {
		if (error instanceof LanguagePackValidationError) {
			return undefined;
		}
		throw error;
	}
}

function validateTranslationMessages(value: unknown, path: string): Readonly<Record<string, string>> {
	if (!isRecord(value) || Object.keys(value).length > 10000) {
		throw new LanguagePackValidationError(path, 'expected an object with at most 10000 messages');
	}

	const messages: Record<string, string> = Object.create(null);
	for (const [key, message] of Object.entries(value)) {
		const messagePath = `${path}[${JSON.stringify(key)}]`;
		if (!key || key.length > 1024) {
			throw new LanguagePackValidationError(messagePath, 'expected a non-empty message key of at most 1024 characters');
		}
		if (typeof message !== 'string' || message.length > 64 * 1024) {
			throw new LanguagePackValidationError(messagePath, 'expected a string of at most 65536 characters');
		}
		messages[key] = message;
	}

	return messages;
}

// Keep the schema usable by Node build preparation before frontend modules are compiled.
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
