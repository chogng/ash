import { setNlsMessages } from '../../../src/ash/nls.js';
import { productLanguagePackCatalogs } from '../../../src/ash/workbench/services/localization/common/localizationCatalogs.js';

// Load the language pack before the fixture imports contributions that localize menu metadata.
const locale = new URLSearchParams(location.search).get('locale') ?? document.documentElement.lang;
const catalog = productLanguagePackCatalogs.find(candidate => candidate.locale === locale);
if (catalog) setNlsMessages(catalog.locale, catalog.bundles);
