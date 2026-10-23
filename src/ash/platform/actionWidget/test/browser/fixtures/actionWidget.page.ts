import { setIconResolver } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { SelectBox } from '../../../../../base/browser/ui/selectbox/selectbox.js';
import { ActionListItemKind, type IActionListItem, type IActionListOptions } from '../../../browser/actionList.js';
import { ActionWidgetService, IActionWidgetService } from '../../../browser/actionWidget.js';
import { IConfigurationService } from '../../../../configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../configuration/common/inMemoryConfigurationService.js';
import { IContextViewService } from '../../../../contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../../contextview/browser/contextViewService.js';
import { InstantiationService } from '../../../../instantiation/common/instantiationService.js';
import { bindTestColorTheme } from '../../../../../../../test/fixtures/browser/themeFixture.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../theme/common/colorTheme.js';
import type { ColorScheme } from '../../../../theme/common/theme.js';
import { getIconDefinition } from '../../../../theme/common/iconRegistry.js';
import { TestThemeService } from '../../../../theme/test/common/testThemeService.js';
import '../../../../../base/browser/ui/button/button.css';
import '../../../../../base/browser/ui/iconlabel/iconlabel.css';
import '../../../../../base/browser/ui/inputbox/inputbox.css';
import '../../../../../base/browser/ui/actionbar/actionbar.css';
import '../../../../../base/browser/ui/selectbox/selectbox.css';
import '../../../../../base/browser/ui/dropdown/dropdown.css';

declare global {
	interface Window {
		ashActionWidgetIntegration: {
			show(labels: string[], options?: IActionListOptions): void;
			showTabs(): void;
			mountSelect(): void;
			theme(scheme: `${ColorScheme}`): void;
		};
	}
}

const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(document.body)));
services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));
services.registerSingleton(IActionWidgetService, () => services.createInstance(ActionWidgetService));
const theme = resources.add(new TestThemeService(darkColorTheme));
resources.add(bindTestColorTheme(theme, document.body));
setIconResolver(document, getIconDefinition);
const widget = services.get(IActionWidgetService);
const source = document.querySelector<HTMLButtonElement>('#source')!;
const delegate = {
	onSelect(label: string): void {
		document.querySelector('output')!.textContent = label;
		widget.hide(false);
	},
	onHide(): void { },
};
function createItems(labels: readonly string[]): IActionListItem<string>[] {
	return labels.map((label, index) => ({
		kind: ActionListItemKind.Action,
		item: label,
		label,
		checked: index === 0,
		group: { title: '', icon: Lxicon.unlimited },
	}));
}
window.ashActionWidgetIntegration = {
	show(labels, options): void {
		source.focus();
		widget.show('integration', false, createItems(labels), delegate, source, options);
	},
	showTabs(): void {
		source.focus();
		widget.show('tabs', false, [], delegate, source, {}, {
			tabs: [{ id: 'short', label: 'Short' }, { id: 'long', label: 'Long' }],
			initialTab: 'short',
			createActionList: tab => ({ items: createItems([tab === 'short' ? 'Run' : 'Run the selected action with a longer descriptive label']) }),
		});
	},
	mountSelect(): void {
		const select = resources.add(new SelectBox(document.body, {
			ariaLabel: 'Select mode',
			options: [
				{ value: 'alpha', label: 'Alpha' },
				{ value: 'unavailable', label: 'Unavailable', disabled: true },
				{ value: 'beta', label: 'Beta' },
			],
			contextViewProvider: services.get(IContextViewService),
		}));
		resources.add(select.onDidSelect(event => { document.querySelector('output')!.textContent = event.value; }));
	},
	theme(scheme): void {
		theme.setColorTheme({ light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme }[scheme]);
	},
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
