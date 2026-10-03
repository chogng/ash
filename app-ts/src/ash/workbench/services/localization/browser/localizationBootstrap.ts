import { setNlsMessages } from '../../../../nls.js';
import { configurationValues, validateConfigurationSnapshot } from '../../../../platform/configuration/common/configurationIpc.js';
import type { IConfigurationApi } from '../../../../platform/configuration/common/configurationIpc.js';
import type { ILanguagePackStore } from '../../../../platform/languagePacks/common/languagePackStore.js';
import { normalizeLocale } from '../../../../platform/languagePacks/common/languagePackCatalog.js';
import { builtinLanguagePackCatalogs } from '../common/localizationCatalogs.js';

/** This module must not import contributions or the settings registry before NLS is ready. */
export async function initializeBrowserLocalization(configuration: IConfigurationApi, store: ILanguagePackStore): Promise<void> {
	const values = configurationValues(validateConfigurationSnapshot(await configuration.read()).document);
	const preference = values['workbench.locale'];
	const locale = typeof preference === 'string' ? normalizeLocale(preference) : 'en';
	const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale.toLowerCase() === locale.toLowerCase()) ?? await store.read(locale);
	if (!catalog) { throw new Error(`Display language '${locale}' is not installed locally`); }
	setNlsMessages(catalog.locale, catalog.bundles);
}
