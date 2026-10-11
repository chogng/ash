import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { LanguagePackCatalog } from './languagePacksService.js';
import type { LanguagePackIndexEntry } from './languagePackContract.js';

/** Local UI resources remain available before connecting to any backend. */
export interface ILanguagePackStore {
	read(locale: string): Promise<LanguagePackCatalog | undefined>;
	write(catalog: LanguagePackCatalog): Promise<void>;
	readIndex(): Promise<readonly LanguagePackIndexEntry[]>;
	replace(entries: readonly LanguagePackIndexEntry[]): Promise<void>;
}

export const ILanguagePackStore = createServiceIdentifier<ILanguagePackStore>('languagePackStore');
export const NLS_CONFIGURATION_CHANNEL = 'ash:localization:configuration';
export const NLS_ACTIVATE_CHANNEL = 'ash:localization:activate';
