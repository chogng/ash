import assert from 'node:assert/strict';
import { test } from 'mocha';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import type { IKeybindingEntry } from '../../../../../platform/keybinding/common/keybindingsResource.js';
import { selectSystemWideKeybindings } from '../../electron-browser/systemWideKeybindings.js';

function binding(key: string, extras: Partial<IKeybindingEntry> = {}): IKeybindingEntry {
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
		candidates: [{ accelerator: 'Control+Shift+B', commandId: 'workbench.action.openAgentsWindow', userSettingsLabel: 'ctrl+shift+b' }],
		unsupported: ['ctrl+k ctrl+c'],
		duplicates: ['ctrl+shift+b'],
		ignoredWhen: ['ctrl+shift+b'],
	});
});
