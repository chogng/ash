import assert from 'node:assert/strict';
import { test } from 'mocha';
import { GlobalKeybindingsMainService, type IGlobalShortcutRegistry } from '../../electron-main/globalKeybindingsMainService.js';
import type { INativeSystemWideKeybinding } from '../../../native/common/nativeHost.js';

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
		runCommand: () => {},
		onError: error => { throw error; },
	});

	assert.deepEqual(service.updateKeybindings(1, [{ ...binding('Control+Shift+B'), userSettingsLabel: 'ctrl+shift+b' }]), {
		failed: ['ctrl+shift+b'],
	});
});
