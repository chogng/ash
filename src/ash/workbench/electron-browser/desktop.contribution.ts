import { registerAction2 } from '../../platform/actions/common/actions.js';
import { ToggleDevToolsAction } from './actions/developerActions.js';
import './parts/dialogs/dialog.contribution.js';
import '../contrib/files/electron-browser/fileActions.contribution.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../common/contributions.js';
import {
	ConfigurationScope,
	Extensions as ConfigurationExtensions,
	type IConfigurationRegistry,
} from '../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../platform/registry/common/platform.js';
import {
	DEFAULT_STARTUP_WINDOW,
	STARTUP_WINDOW_SETTING,
	RESTORE_WINDOWS_SETTING,
	WINDOW_ZOOM_LEVEL_SETTING,
	WINDOW_ZOOM_PER_WINDOW_SETTING,
	NEW_WINDOW_DIMENSIONS_SETTING,
	RESTORE_FULLSCREEN_SETTING,
	parseNewWindowDimensions,
	parseRestoreFullscreen,
	parseRestoreWindowsSetting,
	parseStartupWindow,
	type RestoreWindowsSetting,
} from '../../platform/window/common/window.js';
import { localize } from '../../nls.js';
import { NativeWindow } from './window.js';
import { ILayoutService } from '../../platform/layout/browser/layoutService.js';
import { onUnexpectedError } from '../../base/common/errors.js';
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
		if (!Number.isInteger(value) || (value as number) < -8 || (value as number) > 8)
			throw new TypeError('Window zoom level must be an integer from -8 to 8');
		return value as number;
	},
	setting: {
		valueType: 'number',
		minimum: -8,
		maximum: 8,
		title: localize({ bundle: 'ash', key: 'workbench.zoomSettingTitle' }, 'Window zoom level'),
		description: localize(
			{ bundle: 'ash', key: 'workbench.zoomSettingDescription' },
			'Adjust the zoom level of desktop windows.',
		),
	},
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	key: WINDOW_ZOOM_PER_WINDOW_SETTING,
	defaultValue: true,
	parse: value => {
		if (typeof value !== 'boolean') throw new TypeError('Per-window zoom must be a boolean');
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize({ bundle: 'ash', key: 'workbench.zoomPerWindowTitle' }, 'Zoom per window'),
		description: localize(
			{ bundle: 'ash', key: 'workbench.zoomPerWindowDescription' },
			'Adjust zoom independently for each window. Disable to apply zoom to all windows.',
		),
	},
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	key: STARTUP_WINDOW_SETTING,
	defaultValue: DEFAULT_STARTUP_WINDOW,
	parse: parseStartupWindow,
	scope: ConfigurationScope.APPLICATION,
	schema: { type: 'string', enum: ['default', 'ide', 'agents'] },
	setting: {
		valueType: 'select',
		get title() {
			return localize('window.startupWindow.title', 'Open on startup');
		},
		get description() {
			return localize(
				'window.startupWindow.description',
				'Choose which window opens when Ash starts. Takes effect next launch. Opening a project directly takes priority.',
			);
		},
		get options() {
			return [
				{ value: 'default', label: localize('window.startupWindow.default', 'Same as last time (default)') },
				{ value: 'ide', label: localize('window.startupWindow.ide', 'IDE') },
				{ value: 'agents', label: localize('window.startupWindow.agents', 'Agent window') },
			] as const;
		},
	},
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration<RestoreWindowsSetting>(
	{
		key: RESTORE_WINDOWS_SETTING,
		defaultValue: 'all',
		parse: parseRestoreWindowsSetting,
		setting: {
			valueType: 'select',
			get title() {
				return localize('window.restoreWindows.title', 'Restore windows');
			},
			get description() {
				return localize(
					'window.restoreWindows.description',
					'Choose which windows reopen when Ash starts. Opening a folder or workspace directly takes priority, except with Preserve.',
				);
			},
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
	},
);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	key: NEW_WINDOW_DIMENSIONS_SETTING,
	defaultValue: 'default',
	parse: parseNewWindowDimensions,
	scope: ConfigurationScope.APPLICATION,
	schema: { type: 'string', enum: ['default', 'inherit', 'offset', 'maximized', 'fullscreen'] },
	setting: {
		valueType: 'select',
		get title() {
			return localize('window.newWindowDimensions.title', 'New window dimensions');
		},
		get description() {
			return localize(
				'window.newWindowDimensions.description',
				'Choose the size and position of new windows. Previously opened windows restore their saved size and position.',
			);
		},
		get options() {
			return [
				{
					value: 'default',
					label: localize('window.newWindowDimensions.default', 'Default size, centered on screen'),
				},
				{
					value: 'inherit',
					label: localize(
						'window.newWindowDimensions.inherit',
						'Same size and position as the last active window',
					),
				},
				{
					value: 'offset',
					label: localize(
						'window.newWindowDimensions.offset',
						'Same size as the last active window, with an offset',
					),
				},
				{ value: 'maximized', label: localize('window.newWindowDimensions.maximized', 'Maximized') },
				{ value: 'fullscreen', label: localize('window.newWindowDimensions.fullscreen', 'Full screen') },
			] as const;
		},
	},
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	key: RESTORE_FULLSCREEN_SETTING,
	defaultValue: false,
	parse: parseRestoreFullscreen,
	scope: ConfigurationScope.APPLICATION,
	schema: { type: 'boolean' },
	setting: {
		valueType: 'boolean',
		get title() {
			return localize('window.restoreFullscreen.title', 'Restore full screen');
		},
		get description() {
			return localize(
				'window.restoreFullscreen.description',
				'Reopen windows in full screen if they were closed in full screen.',
			);
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
registerWorkbenchContribution('workbench.contrib.nativeWindow', WorkbenchPhase.AfterRestored, accessor => {
	const window = accessor.get(IInstantiationService).createInstance(NativeWindow);
	void window.initialize(accessor.get(ILayoutService).mainContainer).catch(onUnexpectedError);
	return window;
});
