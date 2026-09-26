import { onUnexpectedError } from '../../../../base/common/errors.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { commandActionLabel, localizedString } from '../../../../platform/action/common/action.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { WorkbenchConfiguration } from '../../../common/configuration.js';

interface ThemeQuickPickItem extends IQuickPickItem {
	readonly value: string;
}

const themesMenu = new MenuId('ThemesSubMenu');
MenusRegistry.appendMenuItem(MenuId.GlobalActivity, {
	title: localizedString('ash', 'workbench.manageThemes', 'Themes'),
	submenu: themesMenu,
	group: '2_configuration',
	order: 7,
});

const themeActions = [
	{
		id: 'workbench.action.selectTheme',
		title: localizedString('ash', 'workbench.selectColorTheme', 'Color Theme'),
		setting: WorkbenchConfiguration.colorTheme,
	},
	{
		id: 'workbench.action.selectIconTheme',
		title: localizedString('ash', 'workbench.selectFileIconTheme', 'File Icon Theme'),
		setting: WorkbenchConfiguration.iconTheme,
	},
	{
		id: 'workbench.action.selectProductIconTheme',
		title: localizedString('ash', 'workbench.selectProductIconTheme', 'Product Icon Theme'),
		setting: WorkbenchConfiguration.productIconTheme,
	},
] as const;

for (const [index, themeAction] of themeActions.entries()) {
	registerAction2(class SelectThemeAction extends Action2 {
		constructor() {
			super({ id: themeAction.id, title: themeAction.title, f1: true });
		}

		public override run(accessor: ServicesAccessor): void {
			const setting = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfiguration(themeAction.setting)?.setting;
			if (setting?.valueType !== 'select') throw new Error(`Theme setting '${themeAction.setting}' has no choices`);
			const items = setting.options.map(option => {
				if (typeof option.value !== 'string') throw new TypeError(`Theme choice for '${themeAction.setting}' must be a string`);
				return { label: option.label, value: option.value };
			});
			const configuration = accessor.get(IConfigurationService);
			const picker = accessor.get(IQuickInputService).createQuickPick<ThemeQuickPickItem>();
			const disposables = new DisposableStore();
			disposables.add(picker);
			picker.placeholder = commandActionLabel(themeAction.title);
			picker.ariaLabel = picker.placeholder;
			picker.items = items;
			disposables.add(picker.onDidAccept(item => {
				picker.hide();
				void configuration.updateValue(themeAction.setting, item.value).catch(onUnexpectedError);
			}));
			disposables.add(picker.onDidHide(() => disposables.dispose()));
			picker.show();
		}
	});
	MenusRegistry.appendMenuItem(themesMenu, {
		command: { id: themeAction.id, title: themeAction.title },
		order: index + 1,
	});
}
