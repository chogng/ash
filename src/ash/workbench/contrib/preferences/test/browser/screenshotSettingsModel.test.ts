import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { decodeKeybinding, resolveKeybinding } from '../../../../../base/common/keybindings.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import type { IHostService } from '../../../../services/host/browser/host.js';
import { ScreenshotGlobalShortcutSetting, type IScreenshotService, type ScreenshotPermission } from '../../../screenshot/common/screenshot.js';
import '../../../screenshot/browser/screenshot.contribution.js';
import { ScreenshotSettingsModel } from '../../browser/screenshotSettingsModel.js';

const binding = resolveKeybinding(decodeKeybinding(KeyMod.WinCtrl | KeyMod.CtrlCmd | KeyCode.KeyA, OperatingSystem.Macintosh)!, OperatingSystem.Macintosh);
const keybindings: IKeybindingService = {
	inChordMode: false, onDidUpdateKeybindings: Event.None, getKeybindings: () => [],
	enableKeybindingHoldMode: () => undefined, registerSchemaContribution: () => toDisposable(() => { }),
	resolveKeybinding, resolveUserBinding: () => undefined, lookupKeybindings: () => [binding], lookupKeybinding: () => binding,
};
const host: IHostService = { hasFocus: true, onDidChangeFocus: Event.None, openWindow: async () => { }, restart: async () => { }, getScreenshot: async () => undefined };
const permission: ScreenshotPermission = { status: 'denied', canOpenSystemSettings: true, applicationPath: '/Applications/Ash.app' };
const commands = { onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None, executeCommand: async <T>() => undefined as T };
const field = (model: ScreenshotSettingsModel, id: string) => model.fields.find(field => field.id === id)!;
const status = (model: ScreenshotSettingsModel) => { const value = field(model, 'permission'); assert.equal(value.kind, 'status'); return value.kind === 'status' ? value.text : ''; };
const action = async (model: ScreenshotSettingsModel, id: string) => { const value = field(model, id); assert.equal(value.kind, 'action'); if (value.kind === 'action') await value.run(); };
function waitForStatus(model: ScreenshotSettingsModel, text: string): Promise<void> {
	const ready = new DeferredPromise<void>();
	const listener = model.onDidChange(() => { if (status(model).includes(text)) { listener.dispose(); void ready.complete(); } });
	return ready.p;
}

const preferences = { openSettings: async () => { }, openUserSettings: async () => { }, openGlobalKeybindingSettings: async () => { } };

test('Screenshot settings expose OS state and reuse keybinding and configuration authorities', async () => {
	const calls: string[] = [];
	const screenshot: IScreenshotService = {
		onDidChangeShortcut: Event.None, shortcutStatus: { availability: 'unchecked', global: false, activeLabel: '' }, checkShortcut: async () => { },
		captureScreenshot: async () => assert.fail('Settings must not start capture'),
		getPermission: async () => permission,
		openPermissionSettings: async () => { calls.push('settings'); }, revealApplication: async () => { calls.push('reveal'); },
	};
	using configuration = new TestConfigurationService();
	using model = new ScreenshotSettingsModel(screenshot, keybindings, { ...preferences, openGlobalKeybindingSettings: async textual => { assert.equal(textual, false); calls.push('keybindings'); } }, host, configuration, commands);
	const ready = waitForStatus(model, 'Not allowed');
	model.setVisible(true); await ready;
	assert.equal(new Set(model.fields.map(field => field.id)).size, model.fields.length);
	assert.match(JSON.stringify(field(model, 'application')), /\/Applications\/Ash.app/);
	assert.match(JSON.stringify(field(model, 'shortcut')), /A/);
	await action(model, 'settings'); await action(model, 'reveal'); await action(model, 'keybindings');
	assert.deepEqual(calls, ['settings', 'reveal', 'keybindings']);
	const changed = new DeferredPromise<void>();
	using listener = Event.once(configuration.onDidChangeConfiguration)(() => { void changed.complete(); });
	const hints = field(model, 'hints'); assert.equal(hints.kind, 'boolean');
	if (hints.kind === 'boolean') hints.setValue(false);
	await changed.p;
	assert.equal(configuration.getValue(AccessibilityVerbositySettingId.ChatScreenshot), false);
	assert.equal(JSON.parse((await configuration.read()).source)[AccessibilityVerbositySettingId.ChatScreenshot], false);
	assert.deepEqual(model.settingIds, [AccessibilityVerbositySettingId.ChatScreenshot, ScreenshotGlobalShortcutSetting]);
});

test('Screenshot settings ignore old reads after leaving and refresh on returning focus', async () => {
	using focus = new Emitter<boolean>();
	const old = new DeferredPromise<ScreenshotPermission>();
	let reads = 0;
	const screenshot: IScreenshotService = {
		onDidChangeShortcut: Event.None, shortcutStatus: { availability: 'unchecked', global: false, activeLabel: '' }, checkShortcut: async () => { },
		captureScreenshot: async () => undefined,
		getPermission: () => ++reads === 1 ? old.p : Promise.resolve({ ...permission, status: 'granted' }),
		openPermissionSettings: async () => { }, revealApplication: async () => { },
	};
	using configuration = new TestConfigurationService();
	using model = new ScreenshotSettingsModel(screenshot, keybindings, preferences, { ...host, onDidChangeFocus: focus.event }, configuration, commands);
	model.setVisible(true); model.setVisible(false);
	const ready = waitForStatus(model, 'Allowed');
	model.setVisible(true); await ready;
	await old.complete(permission);
	assert.match(status(model), /Allowed/);
	const focused = waitForStatus(model, 'Allowed');
	focus.fire(true); await focused;
	assert.equal(reads, 3);
});

test('Screenshot settings persist background mode and distinguish a rejected request from the retained active binding', async () => {
	using changes = new Emitter<void>();
	let shortcutStatus: import('../../../screenshot/common/screenshot.js').ScreenshotShortcutStatus = { availability: 'unavailable', global: true, activeLabel: 'Control+Command+A' };
	const screenshot: IScreenshotService = {
		onDidChangeShortcut: changes.event, get shortcutStatus() { return shortcutStatus; }, checkShortcut: async () => { },
		captureScreenshot: async () => undefined, getPermission: async () => permission,
		openPermissionSettings: async () => { }, revealApplication: async () => { },
	};
	using configuration = new TestConfigurationService();
	using model = new ScreenshotSettingsModel(screenshot, keybindings, preferences, host, configuration, commands);
	const ready = waitForStatus(model, 'Not allowed'); model.setVisible(true); await ready;
	const availability = field(model, 'availability');
	assert.equal(availability.kind, 'status');
	if (availability.kind === 'status') assert.match(availability.text, /previous global shortcut remains active: Control\+Command\+A/);
	const changed = new DeferredPromise<void>();
	using listener = Event.once(configuration.onDidChangeConfiguration)(() => { void changed.complete(); });
	const global = field(model, 'global'); assert.equal(global.kind, 'boolean');
	if (global.kind === 'boolean') global.setValue(true);
	await changed.p;
	assert.equal(JSON.parse((await configuration.read()).source)[ScreenshotGlobalShortcutSetting], true);
	shortcutStatus = { availability: 'unsupported', global: true, activeLabel: 'Control+Command+A' }; changes.fire();
	const unsupported = field(model, 'availability');
	assert.equal(unsupported.kind, 'status');
	if (unsupported.kind === 'status') {
		assert.match(unsupported.text, /cannot be registered as a global shortcut/);
		assert.match(unsupported.text, /previous global shortcut remains active: Control\+Command\+A/);
	}
	shortcutStatus = { availability: 'available', global: true, activeLabel: 'Control+Command+B' }; changes.fire();
	const active = field(model, 'availability');
	if (active.kind === 'status') { assert.match(active.text, /Global screenshot shortcut active: Control\+Command\+B/); assert.doesNotMatch(active.text, /previous/); }
});
