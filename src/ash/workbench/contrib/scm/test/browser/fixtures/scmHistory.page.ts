import { setNlsMessages } from '../../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../services/localization/common/localizationCatalogs.js';
import '../../../../modernUI/browser/media/padding.css';

const query = new URLSearchParams(location.search);
const locale = query.get('locale');
if (locale) {
	const catalog = productLanguagePackCatalogs.find(candidate => candidate.locale === locale)!;
	setNlsMessages(catalog.locale, catalog.bundles);
}
if (query.has('modernUI')) {
	const root = document.querySelector<HTMLElement>('#history-root')!;
	const workbench = document.createElement('div');
	workbench.className = 'ash-workbench modern-ui';
	root.before(workbench);
	workbench.append(root);
	root.classList.add('ash-sidebar-part');
}
await import('../../../../../../../../test/fixtures/browser/scmHistory.page.js');
