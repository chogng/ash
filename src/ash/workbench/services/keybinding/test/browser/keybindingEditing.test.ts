import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'mocha';
import { ResolvedKeybindingItem } from '../../../../../platform/keybinding/common/resolvedKeybindingItem.js';
import { IKeybindingEditingService } from '../../common/keybindingEditing.js';
import { parseUserKeybindings } from '../../common/keybindingIO.js';
import { KeybindingTestServices } from './keybindingTestServices.js';

function userItem(source: string, index = 0): ResolvedKeybindingItem {
	const entry = parseUserKeybindings(source)[index]!;
	return new ResolvedKeybindingItem(undefined, entry.command, entry.args, undefined, false, null, false, { index, entry });
}

test('keybindings JSONC validates complete ordered rules before installation', () => {
	const source = '// user shortcuts\n[{"key":"primary+k primary+c","command":"ash.comment","when":"editorFocus && mode == edit","args":{"source":"keyboard"},"mac":"cmd+k cmd+c","linux":null,"systemWide":true},]';
	assert.deepEqual(parseUserKeybindings(source)[0], { key: 'primary+k primary+c', command: 'ash.comment', when: 'editorFocus && mode == edit', args: { source: 'keyboard' }, mac: 'cmd+k cmd+c', linux: null, systemWide: true });
	assert.deepEqual(parseUserKeybindings('// no shortcuts'), []);
	for (const invalid of [
		[{ key: 'ctrl+k', command: 'ash.test', unknown: true }],
		[{ key: 'ctrl+k', command: 'ash.test', when: 'editorFocus &&' }],
		[{ key: 'ctrl+k', command: 'ash.test', systemWide: 'yes' }],
		[{ key: 'ctrl+k', command: null, args: {} }],
		[{ key: 'ctrl+k', command: 'ash.test' }, { key: 'invalid+', command: 'ash.test' }],
	]) assert.throws(() => parseUserKeybindings(JSON.stringify(invalid)));
});

test('shortcut editing preserves comments, arguments and OS overrides in the shared JSON model', async () => {
	using fixture = new KeybindingTestServices();
	const source = '// user shortcuts\n[\n  {"key":"ctrl+k", /* explain binding */ "command":"ash.test","args":{"kind":"text"},"mac":"cmd+k","systemWide":true},\n]\n';
	await fixture.writeSource(source);
	const resource = fixture.profiles.currentProfile.keybindingsResource;
	using reference = await fixture.models.acquire({ resource, languageId: 'jsonc' }, new AbortController().signal);
	const editing = fixture.services.get(IKeybindingEditingService);
	await editing.editKeybinding(userItem(source), 'ctrl+j', 'editorFocus');
	const result = await fixture.files.readFile(resource);
	assert.match(result.content, /\/\/ user shortcuts/u);
	assert.match(result.content, /\/\* explain binding \*\//u);
	assert.equal(reference.model.getValue(), result.content);
	assert.equal(reference.isDirty, false);
	assert.deepEqual(await fixture.read(), [{ key: 'ctrl+j', command: 'ash.test', args: { kind: 'text' }, mac: 'cmd+k', systemWide: true, when: 'editorFocus' }]);
	assert.equal(await readFile(join(fixture.directory, 'keybindings.json'), 'utf8'), result.content);
	await assert.rejects(editing.removeKeybinding(userItem(source)), /changed/u);
	await editing.removeKeybinding(userItem(result.content));
	assert.deepEqual(await fixture.read(), []);
	assert.match((await fixture.files.readFile(resource)).content, /user shortcuts/u);
});

test('shortcut list refuses dirty JSON; saving conflicts retain text and the external file', async () => {
	using fixture = new KeybindingTestServices();
	const source = '[{"key":"ctrl+k","command":"ash.test"}]';
	await fixture.writeSource(source);
	const resource = fixture.profiles.currentProfile.keybindingsResource;
	const signal = new AbortController().signal;
	using reference = await fixture.models.acquire({ resource, languageId: 'jsonc' }, signal);
	reference.model.pushEditOperations(null, [{ range: reference.model.getFullModelRange(), text: '// unsaved\n' + source }], null);
	await assert.rejects(fixture.services.get(IKeybindingEditingService).editKeybinding(userItem(source), 'ctrl+j', undefined), /Save keybindings.json/u);
	await fixture.writeSource('[]');
	await fixture.models.refresh(resource);
	assert.equal(reference.hasExternalChange, false);
	await assert.rejects(reference.save(signal), /changed outside/u);
	assert.equal(reference.hasExternalChange, true);
	assert.equal(reference.isDirty, true);
	assert.match(reference.model.getValue(), /unsaved/u);
	assert.deepEqual(await fixture.read(), []);
});
