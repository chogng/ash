import { setNlsMessages } from '../../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../services/localization/common/localizationCatalogs.js';

const locale = new URLSearchParams(location.search).get('locale');
if (locale) {
	const catalog = productLanguagePackCatalogs.find(candidate => candidate.locale === locale)!;
	setNlsMessages(catalog.locale, catalog.bundles);
}
await import('../../../../../../../../test/fixtures/browser/scmHistory.page.js');
