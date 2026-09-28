import {
	registerAction2,
} from "../../platform/actions/common/actions.js";
import {
	ToggleDevToolsAction,
} from "./actions/developerActions.js";
import { InstallShellCommandAction, UninstallShellCommandAction } from './actions/installActions.js';
import './parts/dialogs/dialog.contribution.js';
import '../contrib/files/electron-browser/fileActions.contribution.js';
import { INativeHostService } from '../common/services.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../common/contributions.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { RESTORE_WINDOWS_SETTING, WINDOW_ZOOM_LEVEL_SETTING, parseRestoreWindowsSetting, type RestoreWindowsSetting } from '../../platform/window/common/window.js';
import { localize } from '../../nls.js';
import { NativeWindow } from './window.js';
import {
	CloseOtherWindowsAction,
	CloseWindowAction,
	DisableWindowAlwaysOnTopAction,
	EnableWindowAlwaysOnTopAction,
	FocusWindowAction,
	MergeWindowTabsAction,
	MoveWindowTabToNewWindowAction,
	NewWindowTabAction,
	QuickSwitchWindowAction,
	ShowNextWindowTabAction,
	ShowPreviousWindowTabAction,
	SwitchWindowAction,
	ToggleWindowAlwaysOnTopAction,
	ToggleWindowTabsBarAction,
	ZoomInAction,
	ZoomOutAction,
	ZoomResetAction,
} from './actions/windowActions.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	key: WINDOW_ZOOM_LEVEL_SETTING,
	defaultValue: 0,
	parse: value => {
		if (!Number.isInteger(value) || (value as number) < -8 || (value as number) > 8) throw new TypeError('Window zoom level must be an integer from -8 to 8');
		return value as number;
	},
	setting: {
		valueType: 'number', minimum: -8, maximum: 8,
		title: localize({ bundle: 'ash', key: 'workbench.zoomSettingTitle' }, 'Window zoom level'),
		description: localize({ bundle: 'ash', key: 'workbench.zoomSettingDescription' }, 'Adjust the zoom level of desktop windows.'),
	},
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration<RestoreWindowsSetting>({
	key: RESTORE_WINDOWS_SETTING,
	defaultValue: 'all',
	parse: parseRestoreWindowsSetting,
	setting: {
		valueType: 'select',
		get title() { return localize('window.restoreWindows.title', 'Restore windows'); },
		get description() { return localize('window.restoreWindows.description', 'Choose which windows reopen when Ash starts. Opening a folder or workspace directly takes priority, except with Preserve.'); },
		get options() {
			return [
				{ value: 'preserve', label: localize('window.restoreWindows.preserve', 'Preserve all windows') },
				{ value: 'all', label: localize('window.restoreWindows.all', 'All windows') },
				{ value: 'folders', label: localize('window.restoreWindows.folders', 'Folders and workspaces') },
				{ value: 'one', label: localize('window.restoreWindows.one', 'Last active window') },
				{ value: 'none', label: localize('window.restoreWindows.none', 'None') },
			] as const;
		},
	},
});

registerAction2(ToggleDevToolsAction);
registerAction2(CloseWindowAction);
registerAction2(CloseOtherWindowsAction);
registerAction2(FocusWindowAction);
registerAction2(ZoomInAction);
registerAction2(ZoomOutAction);
registerAction2(ZoomResetAction);
registerAction2(SwitchWindowAction);
registerAction2(QuickSwitchWindowAction);
registerAction2(ToggleWindowAlwaysOnTopAction);
registerAction2(EnableWindowAlwaysOnTopAction);
registerAction2(DisableWindowAlwaysOnTopAction);
registerAction2(ToggleWindowTabsBarAction);
registerAction2(NewWindowTabAction);
registerAction2(ShowNextWindowTabAction);
registerAction2(ShowPreviousWindowTabAction);
registerAction2(MoveWindowTabToNewWindowAction);
registerAction2(MergeWindowTabsAction);
registerAction2(InstallShellCommandAction);
registerAction2(UninstallShellCommandAction);
registerWorkbenchContribution('workbench.contrib.nativeWindow', WorkbenchPhase.AfterRestored, accessor => new NativeWindow(
	accessor.get(INativeHostService),
	accessor.get(IConfigurationService),
));
