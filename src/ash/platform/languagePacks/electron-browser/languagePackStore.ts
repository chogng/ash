import { invoke } from '../../ipc/electron-browser/rendererIpc.js';
import { LANGUAGE_PACK_READ_CHANNEL, LANGUAGE_PACK_WRITE_CHANNEL, type ILanguagePackStore } from '../common/languagePackStore.js';
import { parseLanguagePackCatalog } from '../common/languagePackCatalog.js';
import type { LanguagePackCatalog } from '../common/languagePacksService.js';

export class ElectronLanguagePackStore implements ILanguagePackStore {
	public async read(locale: string): Promise<LanguagePackCatalog | undefined> {
		const value = await invoke<unknown>(LANGUAGE_PACK_READ_CHANNEL, locale);
		if (value === undefined) { return undefined; }
		const catalog = parseLanguagePackCatalog(value);
		if (!catalog || catalog.locale !== locale) { throw new Error('Invalid display language resource'); }
		return catalog;
	}

	public write(catalog: LanguagePackCatalog): Promise<void> {
		return invoke<void>(LANGUAGE_PACK_WRITE_CHANNEL, catalog);
	}
}
