import assert from 'node:assert/strict';
import { test } from 'mocha';
import { GlobalKeybindingsMainService, type IGlobalShortcutRegistry } from '../../electron-main/globalKeybindingsMainService.js';
import type { INativeSystemWideKeybinding } from '../../../native/common/nativeHost.js';
import { validateSystemWideKeybindings } from '../../../native/common/nativeHost.js';

class TestShortcuts implements IGlobalShortcutRegistry {
	readonly callbacks = new Map<string, () => void>();
	readonly registrations: string[] = [];
	readonly releases: string[] = [];
	readonly unavailable = new Set<string>();

	register(accelerator: string, callback: () => void): boolean {
		this.registrations.push(accelerator);
		if (this.unavailable.has(accelerator)) return false;
		this.callbacks.set(accelerator, callback);
		return true;
	}

	isRegistered(accelerator: string): boolean { return this.callbacks.has(accelerator); }

	unregister(accelerator: string): void {
		this.releases.push(accelerator);
		this.callbacks.delete(accelerator);
	}
}

function binding(accelerator: string): INativeSystemWideKeybinding {
	return { accelerator, commandId: 'workbench.action.openAgentsWindow', userSettingsLabel: accelerator };
}

test('global shortcut opens in the active window and releases with its last owner', async () => {
	const shortcuts = new TestShortcuts();
	let activeWindowId = 1;
	const opened: number[] = [];
	using service = new GlobalKeybindingsMainService({
		shortcuts,
		activeWindowId: () => activeWindowId,
		runCommand: windowId => { opened.push(windowId); },
		onError: error => { throw error; },
	});

	assert.deepEqual(service.updateKeybindings(1, [binding('Control+Shift+A')]), { failed: [] });
	assert.deepEqual(service.updateKeybindings(2, [binding('Control+Shift+A')]), { failed: [] });
	assert.deepEqual(shortcuts.registrations, ['Control+Shift+A']);
	shortcuts.callbacks.get('Control+Shift+A')!();
	await Promise.resolve();
	activeWindowId = 2;
	shortcuts.callbacks.get('Control+Shift+A')!();
	await Promise.resolve();
	assert.deepEqual(opened, [1, 2]);

	service.removeWindow(2);
	assert.deepEqual(shortcuts.releases, []);
	service.updateKeybindings(1, []);
	assert.deepEqual(shortcuts.releases, ['Control+Shift+A']);
	assert.equal(shortcuts.callbacks.size, 0);
});

test('unavailable operating-system shortcut reports its user label', () => {
	const shortcuts = new TestShortcuts();
	shortcuts.unavailable.add('Control+Shift+B');
	using service = new GlobalKeybindingsMainService({
		shortcuts,
		activeWindowId: () => 1,
		runCommand: () => { },
		onError: error => { throw error; },
	});

	assert.deepEqual(service.updateKeybindings(1, [{ ...binding('Control+Shift+B'), userSettingsLabel: 'ctrl+shift+b' }]), {
		failed: ['ctrl+shift+b'],
	});
});

test('system-wide shortcut retains and dispatches arguments after the editor owner closes', async () => {
	const shortcuts = new TestShortcuts();
	const calls: unknown[] = [];
	const args = { draft: { mode: 'agent', text: 'Review this', contexts: [] } };
	using service = new GlobalKeybindingsMainService({
		shortcuts,
		activeWindowId: () => 2,
		runCommand: (windowId, commandId, options) => { calls.push({ windowId, commandId, options }); },
		onError: error => { throw error; },
	});
	const payload = validateSystemWideKeybindings(JSON.parse(JSON.stringify([{ ...binding('Control+Shift+A'), args }])));
	assert.throws(() => validateSystemWideKeybindings([{ ...binding('Control+Shift+A'), args: () => { } }]), /must be an object/);
	assert.throws(() => validateSystemWideKeybindings([{ ...binding('Control+Shift+A'), unexpected: true }]), /Invalid system-wide/);
	service.updateKeybindings(1, payload);
	service.updateKeybindings(2, payload);
	service.removeWindow(1);
	shortcuts.callbacks.get('Control+Shift+A')!();
	await Promise.resolve();
	assert.deepEqual({ calls, releases: shortcuts.releases }, {
		calls: [{ windowId: 2, commandId: 'workbench.action.openAgentsWindow', options: args }],
		releases: [],
	});
	service.removeWindow(2);
	assert.deepEqual(shortcuts.releases, ['Control+Shift+A']);
});

test('contribution shortcuts acquire replacements before releasing the previous working shortcut', () => {
	const shortcuts = new TestShortcuts();
	const fired: string[] = [];
	using service = new GlobalKeybindingsMainService({ shortcuts, activeWindowId: () => undefined, runCommand: () => assert.fail('Wrong owner'), onError: error => { throw error; } });
	using owner = service.createOwner(1, binding => fired.push(binding.accelerator));
	assert.equal(owner.update(binding('Control+A')), true);
	shortcuts.unavailable.add('Control+B');
	assert.equal(owner.update(binding('Control+B')), false);
	assert.equal(owner.getBinding()?.accelerator, 'Control+A');
	assert.deepEqual(shortcuts.releases, []);
	shortcuts.callbacks.get('Control+A')!();
	assert.deepEqual(fired, ['Control+A']);
	assert.equal(owner.update(binding('Control+C')), true);
	assert.equal(shortcuts.callbacks.has('Control+C'), true);
	assert.deepEqual(shortcuts.releases, ['Control+A']);
	owner.dispose();
	assert.deepEqual(shortcuts.releases, ['Control+A', 'Control+C']);
});

test('temporary availability checks release only their own registration and preserve existing owners', () => {
	const shortcuts = new TestShortcuts();
	using service = new GlobalKeybindingsMainService({ shortcuts, activeWindowId: () => undefined, runCommand: () => { }, onError: error => { throw error; } });
	using owner = service.createOwner(1, () => { });
	shortcuts.unavailable.add('Control+A');
	assert.equal(owner.check('Control+A', 'screenshot'), false);
	assert.deepEqual(shortcuts.releases, []);
	assert.equal(owner.check('Control+B', 'screenshot'), true);
	assert.deepEqual(shortcuts.releases, ['Control+B']);
	const foreignCallback = () => { };
	shortcuts.register('Control+C', foreignCallback);
	assert.equal(owner.check('Control+C', 'screenshot'), false);
	assert.equal(shortcuts.callbacks.get('Control+C'), foreignCallback);
	owner.update(binding('Control+D'));
	assert.equal(owner.check('Control+D', 'workbench.action.openAgentsWindow'), true);
	assert.equal(owner.check('Control+D', 'screenshot'), false);
	assert.equal(shortcuts.callbacks.has('Control+D'), true);
});

test('contribution ownership survives user shortcut synchronization and releases when its window closes', () => {
	const shortcuts = new TestShortcuts();
	const fired: string[] = [];
	using service = new GlobalKeybindingsMainService({ shortcuts, activeWindowId: () => 1, runCommand: () => { fired.push('user'); }, onError: error => { throw error; } });
	using owner = service.createOwner(1, () => fired.push('screenshot'));
	owner.update({ ...binding('Control+A'), commandId: 'screenshot' });
	service.updateKeybindings(1, [binding('Control+B')]);
	assert.equal(shortcuts.callbacks.has('Control+A'), true);
	assert.deepEqual(service.updateKeybindings(1, [binding('Control+A')]), { failed: ['Control+A'] });
	shortcuts.callbacks.get('Control+A')!();
	assert.deepEqual(fired, ['screenshot']);
	service.removeWindow(1);
	assert.equal(shortcuts.callbacks.has('Control+A'), false);
});

test('contribution global shortcut falls back while a non-owner window has focus', () => {
	const shortcuts = new TestShortcuts();
	let fired = 0;
	using service = new GlobalKeybindingsMainService({ shortcuts, activeWindowId: () => 99, runCommand: () => assert.fail('Wrong routing'), onError: error => { throw error; } });
	using owner = service.createOwner(1, () => { fired++; });
	owner.update(binding('Control+A'));
	shortcuts.callbacks.get('Control+A')!();
	assert.equal(fired, 1);
});
