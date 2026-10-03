import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { LanguagePackCatalog } from './languagePacksService.js';

/** Local UI resources remain available before connecting to any backend. */
export interface ILanguagePackStore {
	read(locale: string): Promise<LanguagePackCatalog | undefined>;
	write(catalog: LanguagePackCatalog): Promise<void>;
}

export const ILanguagePackStore = createServiceIdentifier<ILanguagePackStore>('languagePackStore');
export const NLS_CONFIGURATION_CHANNEL = 'ash:localization:configuration';
export const LANGUAGE_PACK_WRITE_CHANNEL = 'ash:localization:write';
export const LANGUAGE_PACK_READ_CHANNEL = 'ash:localization:read';
