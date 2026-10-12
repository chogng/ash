import type { Event } from "../../../base/common/event.js";
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";
import type { URI } from '../../../base/common/uri.js';
import type { IQuickPickItem } from '../../quickinput/common/quickInput.js';

import type { LanguagePackCatalog } from "./languagePackContract.js";

export interface ILanguagePackItem extends IQuickPickItem {
	readonly id: string;
	readonly extensionId?: string;
}

/**
 * Acquires and projects display-language packs for one client window.
 *
 * Implementations own installed catalog discovery, capability leases, resource decoding,
 * and catalog validation. Locale selection and message lookup consume this
 * contract without depending on Extensions transport details.
 */
export interface ILanguagePackService {
	readonly onDidChange: Event<void>;
	readonly whenReady: Promise<void>;
	readonly catalogs: readonly LanguagePackCatalog[];
	getInstalledLanguages(): Promise<ILanguagePackItem[]>;
	getBuiltInExtensionTranslationsUri(id: string, language: string): Promise<URI | undefined>;

	refresh(): Promise<void>;
}

export const ILanguagePackService = createServiceIdentifier<ILanguagePackService>("languagePackService");
