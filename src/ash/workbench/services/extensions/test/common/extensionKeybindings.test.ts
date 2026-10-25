import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'mocha';
import { isMacintosh, isLinux } from '../../../../../base/common/platform.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import type { ExtensionDescriptor } from '../../../../../platform/extensions/common/extensionApi.js';
import { AdapterManager } from '../../../../contrib/debug/browser/debugAdapterManager.js';
import { createEmptyTestLanguagePacks } from '../../../localization/test/common/localizationTestUtils.js';
import { AppServerExtensionService } from '../../browser/appServerExtensionService.js';
import { parseExtensionManifest } from '../../common/extensionManifest.js';

const identity = { id: 'ash.keys', name: 'keys', publisher: 'ash', version: '1.0.0' };
const parse = (keybindings: unknown) => parseExtensionManifest(JSON.stringify({ ...identity, contributes: { keybindings } }), identity);

test('Keybinding declarations validate every platform and preserve context and structured arguments', () => {
	const manifest = parse([{ key: 'ctrl+d', mac: 'cmd+d', linux: 'alt+d', command: 'test.select', when: 'editorTextFocus', args: { value: 12 } }]);
	const rule = manifest.contributes.keybindings[0]!;
	assert.equal(rule.command, 'test.select');
	assert.deepEqual([...rule.when!.keys()], ['editorTextFocus']);
	assert.deepEqual(rule.args, [{ value: 12 }]);
	const emptyOverride = isMacintosh ? { mac: '' } : isLinux ? { linux: '' } : { win: '' };
	assert.deepEqual(parse([{ key: 'ctrl+d', ...emptyOverride, command: 'test.select' }]).contributes.keybindings, []);
	for (const contribution of [
		{ key: 'invalid-key-name', command: 'test.select' },
		{ key: 'ctrl+d', mac: 42, command: 'test.select' },
		{ key: 'ctrl+d', command: '-test.select' },
		{ key: 'ctrl+d', command: 'test.select', when: '(' },
	]) { assert.throws(() => parse([contribution]), TypeError); }
});

test('A real optional keymap admits editing bindings, rejects command execution and retires its registrations', async () => {
	const manifest = JSON.parse(await readFile('extensions/keymap-sublime/package.json', 'utf8'));
	manifest.contributes.keybindings.push(
		{ key: 'ctrl+k', command: 'workbench.action.terminal.sendSequence', args: { text: 'unexpected execution\n' } },
		{ key: 'ctrl+shift+q', command: 'editor.action.copyLinesDownAction', args: { unexpected: true } },
	);
	const manifestJson = JSON.stringify(manifest);
	const descriptor: ExtensionDescriptor = { id: 'ash.keymap-sublime', displayName: 'Sublime Text Keymap', name: manifest.name, publisher: manifest.publisher, version: manifest.version, sourceKind: 'registry', manifestJson, manifestSha256: 'sha256:' + createHash('sha256').update(manifestJson).digest('hex'), packageSha256: 'sha256:' + 'a'.repeat(64) };
	let extensions = [descriptor]; let generation = 0;
	const before = new Set(KeybindingsRegistry.getKeybindings());
	using adapters = new AdapterManager();
	using service = new AppServerExtensionService({ api: { list: async () => ({ generation: ++generation, extensions, diagnostics: [] }), resources: new ExtensionResourceLoaderService(async () => { throw new Error('A keymap must not load executable resources'); }) } }, createEmptyTestLanguagePacks(), adapters);
	await service.start();
	const added = () => KeybindingsRegistry.getKeybindings().filter(rule => !before.has(rule));
	assert.equal(added().length, 8);
	assert.ok(added().every(rule => rule.priority === KeybindingWeight.ExternalExtension));
	assert.ok(added().every(rule => rule.kind === 'command' && rule.command.startsWith('editor.action.') && rule.args === undefined));
	extensions = []; await service.reload();
	assert.deepEqual(added(), []);
	extensions = [descriptor]; await service.reload();
	assert.equal(added().length, 8);
	service.dispose();
	assert.deepEqual(added(), []);
});
