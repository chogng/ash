import { TabList, type TabListItem } from '../../../browser/ui/tablist/tabList.js';
import { DisposableStore } from '../../../common/lifecycle.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../platform/theme/test/common/testThemeService.js';
import { bindTestColorTheme } from '../../../../../../test/fixtures/browser/themeFixture.js';

const resources = new DisposableStore();
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const theme = resources.add(new TestThemeService(lightColorTheme));
resources.add(bindTestColorTheme(theme, document.body));
const chinese = new URLSearchParams(location.search).get('locale') === 'zh-CN';
const labels = chinese ? ['技能', '连接器', '插件'] : ['Skills', 'Connectors', 'Plugins'];
const items: TabListItem<string>[] = labels.map((label, index) => ({ id: String(index), value: String(index), label, tabId: `category-${index}` }));
let selectedId = '0';
const navigation = resources.add(new TabList<string>(document.querySelector('#navigation')!, {
	ariaLabel: 'Categories', presentation: 'navigation',
	onActivate: id => { selectedId = id; navigation.setTabs(items, id); },
}));
navigation.setTabs(items, selectedId);
const documents = resources.add(new TabList(document.querySelector('#document')!, {
	ariaLabel: 'Documents', presentation: 'inset', onActivate: () => { },
}));
documents.setTabs([{ id: 'file', value: 'file', label: 'File', tabId: 'file-tab' }], 'file');

declare global {
	interface Window {
		ashTabListIntegration: {
			theme(id: keyof typeof themes): void;
			refresh(): void;
		};
	}
}
window.ashTabListIntegration = {
	theme: id => theme.setColorTheme(themes[id]),
	refresh: () => navigation.setTabs(items.map(item => ({ ...item })), selectedId),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
document.body.dataset.ready = 'true';
