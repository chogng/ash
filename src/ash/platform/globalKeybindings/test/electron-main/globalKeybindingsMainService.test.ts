import assert from 'node:assert/strict';
import { test } from 'mocha';
import {
	GlobalKeybindingsMainService,
	type IGlobalShortcutRegistry,
} from '../../electron-main/globalKeybindingsMainService.js';
import type { INativeSystemWideKeybinding } from '../../../native/common/nativeHost.js';
import { validateSystemWideKeybindings } from '../../../native/common/nativeHost.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import {
	GLOBAL_KEYBINDING_TRIGGER_CHANNEL,
	validateGlobalKeybindingRequest,
	validateGlobalKeybindingResult,
} from '../../common/globalKeybindings.js';

ensureNoDisposablesAreLeakedInTestSuite();

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

	isRegistered(accelerator: string): boolean {
		return this.callbacks.has(accelerator);
	}

	unregister(accelerator: string): void {
		this.releases.push(accelerator);
		this.callbacks.delete(accelerator);
	}
}

function binding(accelerator: string): INativeSystemWideKeybinding {
	return { accelerator, commandId: 'workbench.action.openAgentsWindow', userSettingsLabel: accelerator };
}

test('renderer shortcut leases preserve failed replacements and release on navigation, crash and disposal', () => {
	const shortcuts = new TestShortcuts();
	const messages: unknown[] = [];
	using service = new GlobalKeybindingsMainService({
		shortcuts,
		activeWindowId: () => 1,
		runCommand: () => assert.fail('Renderer leases dispatch to their owning renderer'),
		onError: error => {
			throw error;
		},
	});
	using lifetime = new DisposableStore();
	const contents = Object.assign(new EventEmitter(), {
		isDestroyed: () => false,
		send: (...args: unknown[]) => messages.push(args),
	});
	const window = { id: 1, webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
	const route = service.createWindowRoutes(window, lifetime)[0];
	const update = (accelerator: string) =>
		route.invoke(
			route.validate({
				id: 'image.capture',
				commandId: 'test.image.capture',
				accelerator,
				label: accelerator,
				global: true,
			}),
		);
	assert.deepEqual(update('Control+Shift+A'), { available: true, activeLabel: 'Control+Shift+A' });
	shortcuts.unavailable.add('Control+Shift+B');
	assert.deepEqual(update('Control+Shift+B'), { available: false, activeLabel: 'Control+Shift+A' });
	shortcuts.callbacks.get('Control+Shift+A')!();
	assert.deepEqual(messages, [[GLOBAL_KEYBINDING_TRIGGER_CHANNEL, { id: 'image.capture' }]]);
	contents.emit('did-start-navigation', {}, 'file:///workbench.html#selection', true, true);
	assert.equal(shortcuts.callbacks.size, 1);
	contents.emit('did-start-navigation', {}, 'file:///workbench.html', false, true);
	assert.equal(shortcuts.callbacks.size, 0);
	update('Control+Shift+A');
	contents.emit('render-process-gone');
	assert.equal(shortcuts.callbacks.size, 0);
	update('Control+Shift+A');
	lifetime.dispose();
	assert.equal(shortcuts.callbacks.size, 0);
	assert.equal(contents.listenerCount('render-process-gone'), 0);
	assert.throws(() => update('Control+Shift+A'), /scope has closed/);
});

test('global keybinding IPC binds named leases to bounded commands and actual registration results', () => {
	const request = {
		id: 'image.capture',
		commandId: 'test.image.capture',
		accelerator: 'Command+Control+A',
		label: 'Control+Command+A',
		global: true,
	};
	assert.equal(validateGlobalKeybindingRequest(request), request);
	for (const invalid of [
		{ ...request, windowId: 3 },
		{ ...request, accelerator: 'Command+Control+A;other' },
		{ ...request, global: 1 },
		{ ...request, commandId: '' },
	])
		assert.throws(() => validateGlobalKeybindingRequest(invalid));
	assert.deepEqual(validateGlobalKeybindingResult({ available: false, activeLabel: 'Control+Command+B' }), {
		available: false,
		activeLabel: 'Control+Command+B',
	});
	assert.throws(() => validateGlobalKeybindingResult({ available: 'yes', activeLabel: '' }));
});

test('global shortcut opens in the active window and releases with its last owner', async () => {
	const shortcuts = new TestShortcuts();
	let activeWindowId = 1;
	const opened: number[] = [];
	using service = new GlobalKeybindingsMainService({
		shortcuts,
		activeWindowId: () => activeWindowId,
		runCommand: windowId => {
			opened.push(windowId);
		},
		onError: error => {
			throw error;
		},
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
		runCommand: () => {},
		onError: error => {
			throw error;
		},
	});

	assert.deepEqual(
		service.updateKeybindings(1, [{ ...binding('Control+Shift+B'), userSettingsLabel: 'ctrl+shift+b' }]),
		{ failed: ['ctrl+shift+b'] },
	);
});

test('system-wide shortcut retains and dispatches arguments after the editor owner closes', async () => {
	const shortcuts = new TestShortcuts();
	const calls: unknown[] = [];
	const args = { draft: { mode: 'agent', text: 'Review this', contexts: [] } };
	using service = new GlobalKeybindingsMainService({
		shortcuts,
		activeWindowId: () => 2,
		runCommand: (windowId, commandId, options) => {
			calls.push({ windowId, commandId, options });
		},
		onError: error => {
			throw error;
		},
	});
	const payload = validateSystemWideKeybindings(
		JSON.parse(JSON.stringify([{ ...binding('Control+Shift+A'), args }])),
	);
	assert.throws(
		() => validateSystemWideKeybindings([{ ...binding('Control+Shift+A'), args: () => {} }]),
		/must be an object/,
	);
	assert.throws(
		() => validateSystemWideKeybindings([{ ...binding('Control+Shift+A'), unexpected: true }]),
		/Invalid system-wide/,
	);
	service.updateKeybindings(1, payload);
	service.updateKeybindings(2, payload);
	service.removeWindow(1);
	shortcuts.callbacks.get('Control+Shift+A')!();
	await Promise.resolve();
	assert.deepEqual(
		{ calls, releases: shortcuts.releases },
		{ calls: [{ windowId: 2, commandId: 'workbench.action.openAgentsWindow', options: args }], releases: [] },
	);
	service.removeWindow(2);
	assert.deepEqual(shortcuts.releases, ['Control+Shift+A']);
});

test('contribution shortcuts acquire replacements before releasing the previous working shortcut', () => {
	const shortcuts = new TestShortcuts();
	const fired: string[] = [];
	using service = new GlobalKeybindingsMainService({
		shortcuts,
		activeWindowId: () => undefined,
		runCommand: () => assert.fail('Wrong owner'),
		onError: error => {
			throw error;
		},
	});
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
	using service = new GlobalKeybindingsMainService({
		shortcuts,
		activeWindowId: () => undefined,
		runCommand: () => {},
		onError: error => {
			throw error;
		},
	});
	using owner = service.createOwner(1, () => {});
	shortcuts.unavailable.add('Control+A');
	assert.equal(owner.check('Control+A', 'screenshot'), false);
	assert.deepEqual(shortcuts.releases, []);
	assert.equal(owner.check('Control+B', 'screenshot'), true);
	assert.deepEqual(shortcuts.releases, ['Control+B']);
	const foreignCallback = () => {};
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
	using service = new GlobalKeybindingsMainService({
		shortcuts,
		activeWindowId: () => 1,
		runCommand: () => {
			fired.push('user');
		},
		onError: error => {
			throw error;
		},
	});
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
	using service = new GlobalKeybindingsMainService({
		shortcuts,
		activeWindowId: () => 99,
		runCommand: () => assert.fail('Wrong routing'),
		onError: error => {
			throw error;
		},
	});
	using owner = service.createOwner(1, () => {
		fired++;
	});
	owner.update(binding('Control+A'));
	shortcuts.callbacks.get('Control+A')!();
	assert.equal(fired, 1);
});

test('renderer navigation clears user bindings while contribution leases can register again', () => {
	const shortcuts = new TestShortcuts();
	using service = new GlobalKeybindingsMainService({
		shortcuts,
		activeWindowId: () => 1,
		runCommand: () => {},
		onError: error => {
			throw error;
		},
	});
	using owner = service.createOwner(1, () => {});
	for (let navigation = 0; navigation < 2; navigation++) {
		owner.update(binding('Control+A'));
		service.updateKeybindings(1, [binding('Control+B')]);
		service.updateKeybindings(1, []);
		assert.equal(shortcuts.callbacks.has('Control+B'), false);
		assert.equal(shortcuts.callbacks.has('Control+A'), true);
		owner.update(undefined);
		assert.equal(shortcuts.callbacks.size, 0);
		assert.equal(owner.update(binding('Control+A')), true);
	}
	service.removeWindow(1);
	assert.equal(shortcuts.callbacks.size, 0);
	assert.throws(() => owner.update(binding('Control+A')), /Shortcut owner has closed/);
});
