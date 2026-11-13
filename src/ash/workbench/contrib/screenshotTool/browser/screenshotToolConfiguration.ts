import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

const registry = Registry.as<IConfigurationRegistry>(Extensions.Configuration);

registry.registerConfiguration<boolean>({
	key: "screenshot.globalShortcut", defaultValue: false, scope: ConfigurationScope.APPLICATION,
	schema: { "type": "boolean" },
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError(localize('screenshot.invalidSetting', 'Invalid screenshot setting.')); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('screenshot.builtin.global.title', "Capture while Ash is in the background"); },
		get description() { return localize('screenshot.builtin.global.description', "Use the screen capture shortcut from other apps. After capture, choose Copy, Save, or Add to Chat."); },
	},
});

registry.registerConfiguration<boolean>({
	key: "accessibility.verbosity.chatScreenshot", defaultValue: true, scope: ConfigurationScope.WINDOW,
	schema: { "type": "boolean" },
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError(localize('screenshot.invalidSetting', 'Invalid screenshot setting.')); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('screenshot.builtin.accessibility.title', "Screenshot accessibility help"); },
		get description() { return localize('screenshot.builtin.accessibility.description', "Announce how to open accessibility help during screen capture."); },
	},
});

registry.registerConfiguration<number>({
	key: "snapshot.code.padding", defaultValue: 32, scope: ConfigurationScope.APPLICATION,
	schema: { "type": "number", "minimum": 0, "maximum": 128 },
	parse(value: unknown): number {
		if (typeof value !== 'number') { throw new TypeError(localize('screenshot.invalidSetting', 'Invalid screenshot setting.')); }
		if (!Number.isFinite(value) || value < 0 || value > 128) { throw new RangeError(localize('screenshot.invalidRange', 'The screenshot setting is outside the supported range.')); }
		return value;
	},
	setting: {
		valueType: 'number', minimum: 0, maximum: 128,
		get title() { return localize('screenshot.builtin.code.padding.title', "Padding"); },
		get description() { return localize('screenshot.builtin.code.padding', "Padding around a code image, in pixels."); },
	},
});

registry.registerConfiguration<number>({
	key: "snapshot.code.scale", defaultValue: 2, scope: ConfigurationScope.APPLICATION,
	schema: { "type": "number", "minimum": 1, "maximum": 4 },
	parse(value: unknown): number {
		if (typeof value !== 'number') { throw new TypeError(localize('screenshot.invalidSetting', 'Invalid screenshot setting.')); }
		if (!Number.isFinite(value) || value < 1 || value > 4) { throw new RangeError(localize('screenshot.invalidRange', 'The screenshot setting is outside the supported range.')); }
		return value;
	},
	setting: {
		valueType: 'number', minimum: 1, maximum: 4,
		get title() { return localize('screenshot.builtin.code.scale.title', "Resolution scale"); },
		get description() { return localize('screenshot.builtin.code.scale', "Resolution scale for code images."); },
	},
});

registry.registerConfiguration<string>({
	key: "snapshot.code.background", defaultValue: "#6366f1", scope: ConfigurationScope.APPLICATION,
	schema: { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
	parse(value: unknown): string {
		if (typeof value !== 'string') { throw new TypeError(localize('screenshot.invalidSetting', 'Invalid screenshot setting.')); }
		if (!/^#[0-9a-fA-F]{6}$/u.test(value)) { throw new TypeError(localize('screenshot.invalidColor', 'Use a six-digit hexadecimal screenshot color.')); }
		return value;
	},
	setting: {
		valueType: 'text', placeholder: '',
		get title() { return localize('screenshot.builtin.code.background.title', "Background color"); },
		get description() { return localize('screenshot.builtin.code.background', "Background around the code window, as a six-digit hexadecimal color."); },
	},
});

registry.registerConfiguration<boolean>({
	key: "snapshot.code.lineNumbers", defaultValue: true, scope: ConfigurationScope.APPLICATION,
	schema: { "type": "boolean" },
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError(localize('screenshot.invalidSetting', 'Invalid screenshot setting.')); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('screenshot.builtin.code.lineNumbers.title', "Show line numbers"); },
		get description() { return localize('screenshot.builtin.code.lineNumbers', "Show line numbers in code images."); },
	},
});

registry.registerConfiguration<boolean>({
	key: "snapshot.code.realLineNumbers", defaultValue: true, scope: ConfigurationScope.APPLICATION,
	schema: { "type": "boolean" },
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError(localize('screenshot.invalidSetting', 'Invalid screenshot setting.')); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('screenshot.builtin.code.realLineNumbers.title', "Use document line numbers"); },
		get description() { return localize('screenshot.builtin.code.realLineNumbers', "Use original document line numbers."); },
	},
});

registry.registerConfiguration<boolean>({
	key: "snapshot.code.windowControls", defaultValue: true, scope: ConfigurationScope.APPLICATION,
	schema: { "type": "boolean" },
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError(localize('screenshot.invalidSetting', 'Invalid screenshot setting.')); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('screenshot.builtin.code.windowControls.title', "Show window controls"); },
		get description() { return localize('screenshot.builtin.code.windowControls', "Show decorative window controls in code images."); },
	},
});

registry.registerConfiguration<boolean>({
	key: "snapshot.code.windowTitle", defaultValue: true, scope: ConfigurationScope.APPLICATION,
	schema: { "type": "boolean" },
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError(localize('screenshot.invalidSetting', 'Invalid screenshot setting.')); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('screenshot.builtin.code.windowTitle.title', "Show file name"); },
		get description() { return localize('screenshot.builtin.code.windowTitle', "Show the file name in code images."); },
	},
});

registry.registerConfiguration<boolean>({
	key: "snapshot.code.transparent", defaultValue: false, scope: ConfigurationScope.APPLICATION,
	schema: { "type": "boolean" },
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError(localize('screenshot.invalidSetting', 'Invalid screenshot setting.')); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('screenshot.builtin.code.transparent.title', "Transparent background"); },
		get description() { return localize('screenshot.builtin.code.transparent', "Use a transparent outer background in code images."); },
	},
});
