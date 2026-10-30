import {
	TabList,
	type TabListItem,
	type TabListPresentation,
	type TabListSizing,
} from '../../../browser/ui/tablist/tabList.js';
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
const categoryLabels = chinese
	? ['差异', '工作台', '用于验证长分类名称不会被文档标签宽度限制截断的预览窗口']
	: ['Diff', 'Workbench', 'A preview category whose label is longer than a document tab'];
const categories = resources.add(
	new TabList<string>(document.querySelector('#categories')!, {
		ariaLabel: 'Preview categories',
		presentation: 'inset',
		onActivate: id => categories.setTabs(categoryItems, id),
	}),
);
const categoryItems = categoryLabels.map((label, index) => ({
	id: String(index),
	value: String(index),
	label,
	tabId: `preview-category-${index}`,
}));
categories.setTabs(categoryItems, '0');
const documents = resources.add(
	new TabList(document.querySelector('#document')!, {
		ariaLabel: 'Documents',
		presentation: 'inset',
		onActivate: () => {},
		onClose: () => {},
	}),
);
documents.setTabs([{ id: 'file', value: 'file', label: 'File', tabId: 'file-tab' }], 'file');
documents.setSizing({ mode: 'fixed', minWidth: 120, maxWidth: 120 });

declare global {
	interface Window {
		ashTabListIntegration: {
			theme(id: keyof typeof themes): void;
			refresh(): void;
			presentation(value: TabListPresentation): void;
			sizing(value: TabListSizing): void;
			categoryActions(enabled: boolean): void;
		};
	}
}
window.ashTabListIntegration = {
	theme: id => theme.setColorTheme(themes[id]),
	refresh: () => navigation.setTabs(items.map(item => ({ ...item })), selectedId),
	presentation: value => categories.setPresentation(value),
	sizing: value => categories.setSizing(value),
	categoryActions: enabled =>
		categories.setTabs(
			categoryItems.map((item, index) => ({
				...item,
				primaryAction:
					enabled && index === 0
						? {
								id: 'preview-action',
								label: 'Preview action',
								tooltip: 'Preview action',
								enabled: true,
								run: () => {},
							}
						: undefined,
			})),
			'0',
		),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
document.body.dataset.ready = 'true';
