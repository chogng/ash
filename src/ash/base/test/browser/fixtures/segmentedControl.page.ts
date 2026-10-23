import { SegmentedControl } from '../../../browser/ui/segmentedControl/segmentedControl.js';
import { DisposableStore } from '../../../common/lifecycle.js';
import { Lxicon } from '../../../common/lxicons.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../platform/theme/test/common/testThemeService.js';
import { bindTestColorTheme } from '../../../../../../test/fixtures/browser/themeFixture.js';

declare global {
	interface Window {
		ashSegmentedControlIntegration: {
			select(id: string): void;
			theme(id: string): void;
			dispose(): void;
		};
	}
}

const resources = new DisposableStore();
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const theme = resources.add(new TestThemeService(lightColorTheme));
resources.add(bindTestColorTheme(theme, document.body));
const chinese = new URLSearchParams(location.search).get('locale') === 'zh-CN';
const labels = chinese ? ['列表', '网格', '不可用', '并排视图'] : ['List', 'Grid', 'Unavailable', 'Split view'];
const text = resources.add(new SegmentedControl(document.querySelector('#labels')!, {
	ariaLabel: chinese ? '视图布局' : 'View layout',
	selectedId: 'list',
	items: ['list', 'grid', 'disabled', 'split'].map((id, index) => ({ id, label: labels[index]!, disabled: id === 'disabled' })),
	onActivate: id => { document.querySelector('output')!.textContent = id; },
}));
const icons = resources.add(new SegmentedControl(document.querySelector('#icons')!, {
	ariaLabel: chinese ? '工作区' : 'Workspace',
	selectedId: 'chat', presentation: 'icon',
	items: [
		{ id: 'chat', label: chinese ? '聊天' : 'Chat', icon: Lxicon.chat1 },
		{ id: 'code', label: chinese ? '代码' : 'Code', icon: Lxicon.code },
		{ id: 'projects', label: chinese ? '项目' : 'Projects', icon: Lxicon.projects },
	],
	onActivate: id => icons.setSelection(id),
}));
window.ashSegmentedControlIntegration = {
	select: id => text.setSelection(id),
	theme: id => theme.setColorTheme(themes[id as keyof typeof themes]),
	dispose: () => resources.dispose(),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
document.body.dataset.ready = 'true';
