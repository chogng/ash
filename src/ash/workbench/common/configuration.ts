import { ThemeConfigurationSettings } from '../services/themes/common/themeConfiguration.js';
import { localize } from '../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, type IConfigurationRegistry } from "../../platform/configuration/common/configurationRegistry.js";
import { AccessibilityConfiguration } from "../../platform/accessibility/common/accessibility.js";
import { Registry } from "../../platform/registry/common/platform.js";
import { isMacintosh, isWeb } from "../../base/common/platform.js";
import { DEFAULT_MENU_STYLE, DEFAULT_TITLE_BAR_STYLE, MenuSettings, TitleBarSetting, parseMenuStyle, parseTitleBarStyle, type MenuStyleConfiguration, type TitleBarStyleConfiguration } from "../../platform/window/common/window.js";

export type WorkbenchLayoutStyle = "modern" | "flat";
export type ModernUIEditorTabStyle = 'connected' | 'pill';
export const enum ActivityBarPosition {
	DEFAULT = 'default',
	TOP = 'top',
	BOTTOM = 'bottom',
	HIDDEN = 'hidden',
}
export type SideBarLocation = 'left' | 'right';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

/** Typed configuration keys owned by the workbench layer. */
export const WorkbenchConfiguration = Object.freeze({
	...AccessibilityConfiguration,
	windowTitle: configurationRegistry.registerConfiguration<string>({
		key: 'window.title',
		agentsWindow: { default: '${appName}', readOnly: true },
		defaultValue: '${dirty}${activeEditorShort}${separator}${rootName}${separator}${appName}',
		scope: ConfigurationScope.WINDOW,
		schema: { type: 'string' },
		parse(value: unknown): string {
			if (typeof value === 'string') {
				return value;
			}
			throw new TypeError(localize('window.title.invalid', 'Window title must be text.'));
		},
		setting: {
			valueType: 'text',
			get title() { return localize('window.title.title', 'Window Title'); },
			get description() { return localize('window.title.description', 'Build the title with ${activeEditorShort}, ${activeEditorMedium}, ${activeEditorLong}, ${activeFolderShort}, ${activeFolderMedium}, ${activeFolderLong}, ${folderName}, ${folderPath}, ${rootName}, ${rootPath}, ${appName}, ${dirty}, and ${separator}. Registered context variables are also supported.'); },
			get placeholder() { return localize('window.title.placeholder', 'Title template'); },
		},
	}),
	windowTitleSeparator: configurationRegistry.registerConfiguration<string>({
		key: 'window.titleSeparator',
		defaultValue: ' — ',
		scope: ConfigurationScope.WINDOW,
		schema: { type: 'string' },
		parse(value: unknown): string {
			if (typeof value === 'string') {
				return value;
			}
			throw new TypeError(localize('window.titleSeparator.invalid', 'Window title separator must be text.'));
		},
		setting: {
			valueType: 'text',
			get title() { return localize('window.titleSeparator.title', 'Window Title Separator'); },
			get description() { return localize('window.titleSeparator.description', 'Text inserted by ${separator} between non-empty title values.'); },
			get placeholder() { return localize('window.titleSeparator.placeholder', 'Title separator'); },
		},
	}),
	...(!isWeb ? {
		menuStyle: configurationRegistry.registerConfiguration<MenuStyleConfiguration>({
			key: MenuSettings.MenuStyle,
			defaultValue: DEFAULT_MENU_STYLE,
			parse: parseMenuStyle,
			setting: {
				valueType: 'select',
				get title() { return localize('window.menuStyle.title', 'Menu Style'); },
				get description() { return localize('window.menuStyle.description', 'Choose the context menu style. On Windows and Linux, system menus require a system title bar and changes take effect after restart.'); },
				get options() {
					return [
						{ value: 'custom', label: localize('window.menuStyle.custom', 'Custom') },
						{ value: 'system', label: localize('window.menuStyle.system', 'System') },
						{ value: 'inherit', label: localize('window.menuStyle.inherit', 'Follow title bar') },
					] as const;
				},
			},
		}),
		titleBarStyle: configurationRegistry.registerConfiguration<TitleBarStyleConfiguration>({
			key: TitleBarSetting.TitleBarStyle,
			defaultValue: DEFAULT_TITLE_BAR_STYLE,
			parse: parseTitleBarStyle,
			setting: {
				valueType: 'select',
				get title() { return localize('window.titleBarStyle.title', 'Title Bar Style'); },
				get description() { return localize('window.titleBarStyle.description', 'Choose the window frame style. Changes take effect after restart. The compact application menu remains in Ash’s command bar.'); },
				get options() {
					return [
						{ value: 'custom', label: localize('window.titleBarStyle.custom', 'Custom') },
						{ value: 'system', label: localize('window.titleBarStyle.system', 'System') },
					] as const;
				},
			},
		}),
	} : {}),
	...ThemeConfigurationSettings,
	layoutStyle: configurationRegistry.registerConfiguration<WorkbenchLayoutStyle>({
		key: "workbench.layoutStyle",
		defaultValue: "modern",
		parse(value: unknown): WorkbenchLayoutStyle {
			if (value === "modern" || value === "flat") return value;
			throw new TypeError(`Unknown Workbench layout style: ${String(value)}`);
		},
		setting: {
			valueType: "select",
			title: "Layout style",
			description: "Choose floating Modern surfaces or edge-to-edge Flat Workbench regions.",
			options: [
				{ value: "modern", label: "Modern" },
				{ value: "flat", label: "Flat" },
			],
		},
	}),
	modernUIEditorTabStyle: configurationRegistry.registerConfiguration<ModernUIEditorTabStyle>({
		key: 'workbench.experimental.modernUIEditorTabStyle',
		defaultValue: 'connected',
		scope: ConfigurationScope.WINDOW,
		schema: { type: 'string', enum: ['connected', 'pill'] },
		parse(value: unknown): ModernUIEditorTabStyle {
			if (value === 'connected' || value === 'pill') return value;
			throw new TypeError(localize('workbench.editor.tabStyle.invalid', 'Invalid editor tab style. Use connected or pill.'));
		},
		setting: {
			valueType: 'select',
			get title() { return localize('workbench.editor.tabStyle.title', 'Editor Tab Style'); },
			get description() { return localize('workbench.editor.tabStyle.description', 'Choose connected tabs or separate rounded tabs in the Modern layout. Each tab includes space for its status and close button.'); },
			get options() {
				return [
					{ value: 'connected', label: localize('workbench.editor.tabStyle.connected', 'Connected') },
					{ value: 'pill', label: localize('workbench.editor.tabStyle.pill', 'Pill') },
				] as const;
			},
		},
	}),
	activityBarLocation: configurationRegistry.registerConfiguration<ActivityBarPosition>({
		key: 'workbench.activityBar.location',
		agentsWindow: { default: ActivityBarPosition.DEFAULT, readOnly: true },
		defaultValue: ActivityBarPosition.DEFAULT,
		parse(value: unknown): ActivityBarPosition {
			if (value === ActivityBarPosition.DEFAULT) return ActivityBarPosition.DEFAULT;
			if (value === ActivityBarPosition.TOP) return ActivityBarPosition.TOP;
			if (value === ActivityBarPosition.BOTTOM) return ActivityBarPosition.BOTTOM;
			if (value === ActivityBarPosition.HIDDEN) return ActivityBarPosition.HIDDEN;
			throw new TypeError(`Unknown Activity Bar location: ${String(value)}`);
		},
		setting: {
			valueType: 'select',
			get title() { return localize('workbench.activityBar.location.title', 'Activity Bar Position'); },
			get description() { return localize('workbench.activityBar.location.description', 'Choose where the Activity Bar appears.'); },
			get options() {
				return [
					{ value: ActivityBarPosition.DEFAULT, label: localize('workbench.activityBar.location.side', 'Side') },
					{ value: ActivityBarPosition.TOP, label: localize('workbench.activityBar.location.top', 'Top') },
					{ value: ActivityBarPosition.BOTTOM, label: localize('workbench.activityBar.location.bottom', 'Bottom') },
					{ value: ActivityBarPosition.HIDDEN, label: localize('workbench.activityBar.location.hidden', 'Hidden') },
				] as const;
			},
		},
	}),
	activityBarBadges: configurationRegistry.registerConfiguration<boolean>({
		key: 'workbench.activityBar.badges',
		defaultValue: true,
		scope: ConfigurationScope.APPLICATION,
		schema: { type: 'boolean' },
		parse(value: unknown): boolean {
			if (typeof value === 'boolean') return value;
			throw new TypeError(localize('workbench.activityBar.badges.invalid', 'Activity Bar badges must be true or false.'));
		},
		setting: {
			valueType: 'boolean',
			get title() { return localize('workbench.activityBar.badges.title', 'Activity Bar Badges'); },
			get description() { return localize('workbench.activityBar.badges.description', 'Show badges on Activity Bar icons. Turning this off preserves each icon’s Show Badge or Hide Badge choice.'); },
		},
	}),
	activityBarCompact: configurationRegistry.registerConfiguration<boolean>({
		key: 'workbench.activityBar.compact',
		agentsWindow: { default: false, readOnly: true },
		defaultValue: false,
		parse(value: unknown): boolean {
			if (typeof value === 'boolean') return value;
			throw new TypeError(`Invalid Activity Bar compact value: ${String(value)}`);
		},
		setting: {
			valueType: 'boolean',
			get title() { return localize('workbench.activityBar.compact.title', 'Compact Activity Bar'); },
			get description() { return localize('workbench.activityBar.compact.description', 'Use smaller Activity Bar items when the bar is on the side.'); },
		},
	}),
	sideBarLocation: configurationRegistry.registerConfiguration<SideBarLocation>({
		key: 'workbench.sideBar.location',
		agentsWindow: { default: 'left', readOnly: true },
		defaultValue: 'left',
		parse(value: unknown): SideBarLocation {
			if (value === 'left' || value === 'right') return value;
			throw new TypeError(`Unknown primary side bar location: ${String(value)}`);
		},
		setting: {
			valueType: 'select',
			get title() { return localize('workbench.sideBar.location.title', 'Primary Side Bar Position'); },
			get description() { return localize('workbench.sideBar.location.description', 'Choose which side contains the primary side bar.'); },
			get options() {
				return [
					{ value: 'left', label: localize('workbench.sideBar.location.left', 'Left') },
					{ value: 'right', label: localize('workbench.sideBar.location.right', 'Right') },
				] as const;
			},
		},
	}),
});
