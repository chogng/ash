import assert from 'node:assert/strict';
import { test } from 'mocha';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import type { IUserFriendlyKeybinding } from '../../../../../platform/keybinding/common/keybinding.js';
import { selectSystemWideKeybindings } from '../../electron-browser/systemWideKeybindings.js';

function binding(key: string, extras: Partial<IUserFriendlyKeybinding> = {}): IUserFriendlyKeybinding {
	return { key, command: 'workbench.action.openAgentsWindow', systemWide: true, ...extras };
}

test('system-wide selection rejects chords, duplicates, and disabled OS overrides', () => {
	const selected = selectSystemWideKeybindings([
		binding('ctrl+k ctrl+c'),
		binding('ctrl+shift+b', { when: 'editorFocus' }),
		binding('ctrl+shift+b'),
		binding('ctrl+shift+c', { win: null }),
		{ key: 'ctrl+shift+d', command: 'workbench.action.openAgentsWindow' },
	], OperatingSystem.Windows);

	assert.deepEqual(selected, {
		candidates: [{ accelerator: 'Control+Shift+B', commandId: 'workbench.action.openAgentsWindow', args: undefined, userSettingsLabel: 'ctrl+shift+b' }],
		unsupported: [{ commandId: 'workbench.action.openAgentsWindow', userSettingsLabel: 'ctrl+k ctrl+c' }],
		duplicates: [{ commandId: 'workbench.action.openAgentsWindow', userSettingsLabel: 'ctrl+shift+b' }],
		ignoredWhen: [{ commandId: 'workbench.action.openAgentsWindow', userSettingsLabel: 'ctrl+shift+b' }],
	});
});

test('system-wide selection resolves conflicts across commands and preserves arguments', () => {
	const args = { draft: { mode: 'agent', text: 'Review this', contexts: [] } };
	assert.deepEqual(selectSystemWideKeybindings([
		binding('ctrl+shift+a', { command: 'other.command' }),
		binding('ctrl+shift+a'),
		binding('ctrl+shift+b', { args }),
	], OperatingSystem.Windows), {
		candidates: [
			{ accelerator: 'Control+Shift+A', commandId: 'other.command', args: undefined, userSettingsLabel: 'ctrl+shift+a' },
			{ accelerator: 'Control+Shift+B', commandId: 'workbench.action.openAgentsWindow', args, userSettingsLabel: 'ctrl+shift+b' },
		],
		unsupported: [],
		duplicates: [{ commandId: 'workbench.action.openAgentsWindow', userSettingsLabel: 'ctrl+shift+a' }],
		ignoredWhen: [],
	});
});
