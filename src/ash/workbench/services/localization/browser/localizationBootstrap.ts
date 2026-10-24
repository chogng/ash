import { setNlsMessages } from '../../../../nls.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode, type IFileService } from '../../../../platform/files/common/files.js';
import type { ILanguagePackStore } from '../../../../platform/languagePacks/common/languagePackStore.js';
import { resolveLanguagePackCatalog } from '../../../../platform/languagePacks/common/languagePackCatalog.js';
import { productLanguagePackCatalogs } from '../common/localizationCatalogs.js';

/** This module must not import contributions or the settings registry before NLS is ready. */
export async function initializeBrowserLocalization(files: Pick<IFileService, 'readFile'>, store: Pick<ILanguagePackStore, 'read' | 'write'>): Promise<void> {
	let source = '{}';
	try { source = (await files.readFile(URI.from({ scheme: Schemas.vscodeUserData, path: '/user/settings.json' }))).content; }
	catch (error) { if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileNotFound) throw error; }
	const values = parseJsonc(source) as Record<string, unknown>;
	if (!values || typeof values !== 'object' || Array.isArray(values)) throw new TypeError('Settings must be an object');
	const preference = values['workbench.locale'];
	const catalog = await resolveLanguagePackCatalog(typeof preference === 'string' ? preference : 'en', productLanguagePackCatalogs, store, { preferStartupCatalogs: import.meta.env?.DEV === true });
	setNlsMessages(catalog.locale, catalog.bundles);
}
