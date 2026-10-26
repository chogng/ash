import { Checkbox, Switch } from '../../../browser/ui/toggle/toggle.js';
import { DisposableStore } from '../../../common/lifecycle.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { defaultCheckboxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { TestThemeService } from '../../../../platform/theme/test/common/testThemeService.js';
import { bindTestColorTheme } from '../../../../../../test/fixtures/browser/themeFixture.js';

declare global {
	interface Window {
		ashToggleIntegration: {
			theme(id: string): void;
			checked(value: boolean): void;
			dispose(): void;
		};
	}
}

const resources = new DisposableStore();
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const theme = resources.add(new TestThemeService(lightColorTheme));
resources.add(bindTestColorTheme(theme, document.body));
const changes: boolean[] = [];
const checkbox = resources.add(new Checkbox(document.querySelector('#checkbox')!, {
	...defaultCheckboxStyles,
	label: 'Follow branch',
	onChange: checked => {
		changes.push(checked);
		document.querySelector('output')!.textContent = JSON.stringify(changes);
	},
}));
resources.add(new Checkbox(document.querySelector('#before')!, {
	...defaultCheckboxStyles,
	label: 'Notifications',
	contentPlacement: 'before-control',
	checked: true,
}));
resources.add(new Checkbox(document.querySelector('#disabled')!, {
	...defaultCheckboxStyles,
	label: 'Disabled branch',
	checked: true,
	disabled: true,
}));
resources.add(new Switch(document.querySelector('#switch')!, { label: 'Automatic fetch', checked: true }));
window.ashToggleIntegration = {
	theme: id => theme.setColorTheme(themes[id as keyof typeof themes]),
	checked: value => { checkbox.checked = value; },
	dispose: () => resources.dispose(),
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
document.body.dataset.ready = 'true';
