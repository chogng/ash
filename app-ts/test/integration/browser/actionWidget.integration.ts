import { setIconResolver } from '../../../src/ash/base/browser/ui/lxicons/lxicon.js';
import { DisposableStore } from '../../../src/ash/base/common/lifecycle.js';
import { Lxicon } from '../../../src/ash/base/common/lxicons.js';
import { ActionListItemKind, type IActionListItem, type IActionListOptions } from '../../../src/ash/platform/actionWidget/browser/actionList.js';
import { ActionWidgetService, IActionWidgetService } from '../../../src/ash/platform/actionWidget/browser/actionWidget.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../src/ash/platform/configuration/common/inMemoryConfigurationService.js';
import { IContextViewService } from '../../../src/ash/platform/contextview/browser/contextView.js';
import { BrowserContextViewService } from '../../../src/ash/platform/contextview/browser/contextViewService.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { bindColorTheme } from '../../../src/ash/platform/theme/browser/themeStyles.js';
import { darkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import { getIconDefinition } from '../../../src/ash/platform/theme/common/iconRegistry.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import '../../../src/ash/base/browser/ui/button/button.css';
import '../../../src/ash/base/browser/ui/iconlabel/iconlabel.css';
import '../../../src/ash/base/browser/ui/inputbox/inputbox.css';
import '../../../src/ash/base/browser/ui/actionbar/actionbar.css';

declare global {
	interface Window {
		ashActionWidgetIntegration: {
			show(labels: string[], options?: IActionListOptions): void;
			showTabs(): void;
		};
	}
}

const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(document.body)));
services.registerInstance(IConfigurationService, resources.add(new InMemoryConfigurationService()));
services.registerSingleton(IActionWidgetService, () => services.createInstance(ActionWidgetService));
const theme = resources.add(new TestThemeService(darkColorTheme));
resources.add(bindColorTheme(theme, document.body));
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
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
