import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'mocha';
import { normalizeExtensionHostPayload } from '../../../src/ash/platform/agentHost/browser/extensionHostProtocol.js';

test('the packaged extension binds the public SDK, observes schemas and retires its diagnostics', async () => {
	const fixture = JSON.parse(await readFile('.build/builtin/fixture.json', 'utf8'));
	for (const id of ['ash.json', 'ash.json-language-features']) {
		const manifest = JSON.parse(
			fixture.catalog.extensions.find((value: { id: string }) => value.id === id).manifestJson,
		);
		assert.deepEqual(manifest.ashUiTargets, ['ide', 'agents']);
	}
	const resources = fixture.resources['ash.json-language-features'];
	const directory = await mkdtemp(join(tmpdir(), 'ash-json-extension-'));
	try {
		const module = join(directory, 'extension.mjs');
		await writeFile(module, Buffer.from(resources['extension.ts'], 'base64'));
		const locale = join(directory, 'locale.json');
		const translations = JSON.parse(Buffer.from(resources['l10n/bundle.l10n.zh-CN.json'], 'base64').toString());
		await writeFile(locale, JSON.stringify(normalizeExtensionHostPayload(translations)));
		// Execute the shipped module in an isolated realm with the existing host request boundary.
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				String.raw`
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
globalThis.__ashConfiguration = { extensionId: 'ash.json-language-features', extensionPath: '/', commands: [], manifest: {} };
globalThis.__ashInitialization = { workspaceFolders: [], workspaceName: null, workspaceFile: null, configurationValues: {}, configurationData: { defaults: {contents: {}, keys: [], overrides: []}, folders: [] }, localization: { bundle: JSON.parse(readFileSync(process.argv[2], 'utf8')) } };
globalThis.__ashInvocation = () => 1;
globalThis.__ashRegistrationsChanged = () => {};
let schema = { type: 'object', properties: { enabled: { type: 'boolean', default: true, description: 'Enable the editor' }, spacing: { type: 'number', default: 2 } } };
let entries = [];
globalThis.__ashRequest = async (_id, encoded) => {
 const request = JSON.parse(encoded);
 if (request.operation === 'editorOperation') {
  assert.deepEqual(request.payload, { method: 'jsonSchemaContributions' });
  return JSON.stringify({ result: 'value', value: [{ uri: 'ash://test/schema', fileMatch: ['**/settings.json'], schema }] });
 }
 assert.equal(request.operation, 'setDiagnostics');
 entries = request.entries;
 return JSON.stringify({ result: 'done' });
};
const runtime = await import(pathToFileURL(process.argv[1]).href);
const registrations = await runtime.activate();
const providers = registrations.filter(value => value.kind === 'languageProvider');
assert.deepEqual(providers.map(value => value.operations), [['completion'], ['hover'], ['formatting']]);
assert(providers.every(value => value.languageIds.join(',') === 'json,jsonc'));
const source = { resource: 'file:///settings.json', languageId: 'jsonc', version: 1, text: '{"enabled":"yes"}' };
const invoke = (operation, payload) => runtime.invoke(providers.find(value => value.operations.includes(operation)).registrationId, payload, 1, operation);
const documentEvent = (type, source) => runtime.invoke('ash.documents', { type, document: { uri: source.resource, ...source, isDirty: true }, contentChanges: [] }, 1, 'documentEvent');
await documentEvent('open', source);
assert.equal(entries[0].version, 1);
assert.equal(entries[0].diagnostics[0].message, '类型不正确。应为“boolean”。');
const completions = await invoke('completion', { ...source, text: '{"en"}', position: { lineIndex: 0, columnIndex: 4 }, context: { kind: 'invoke' } });
assert.equal(completions.items[0].label, 'enabled');
assert.equal(completions.items[0].insertTextFormat, 'snippet');
const undocumented = await invoke('completion', { ...source, text: '{"sp"}', position: { lineIndex: 0, columnIndex: 4 }, context: { kind: 'invoke' } });
const spacing = undocumented.items.find(value => value.label === 'spacing');
assert(spacing);
assert.equal(Object.hasOwn(spacing, 'documentation'), false);
const hover = await invoke('hover', { ...source, position: { lineIndex: 0, columnIndex: 3 } });
assert.match(JSON.stringify(hover), /Enable the editor/);
const format = text => invoke('formatting', { ...source, text, kind: 'document', options: { tabSize: 2, insertSpaces: true } });
assert((await format('{/* keep */"enabled":true,}')).edits.length > 0);
schema = { type: 'object', properties: { enabled: { type: 'string' } } };
await runtime.invoke('ash.workspace.events', { type: 'jsonSchemas', revision: 1, emit: true }, 1, 'workspaceEvent');
assert.deepEqual(entries[0].diagnostics, []);
const strict = { resource: 'file:///strict.json', languageId: 'json', version: 1, text: '{// keep\n"enabled":true,}' };
await documentEvent('open', strict);
assert(entries.find(value => value.uri === strict.resource).diagnostics.some(value => value.message === 'JSON 中不允许注释。'));
assert.deepEqual((await invoke('formatting', { ...strict, kind: 'document', options: { tabSize: 2, insertSpaces: true } })).edits, []);
await documentEvent('close', strict);
await documentEvent('close', source);
assert.deepEqual(entries, []);
await runtime.deactivate();
await assert.rejects(invoke('completion', { ...source, position: { lineIndex: 0, columnIndex: 1 }, context: { kind: 'invoke' } }), /not active|disposed/);
console.log('Packaged JSON extension contracts passed');
`,
				module,
				locale,
			],
			{ timeout: 15_000 },
		);
		assert.match(stdout, /Packaged JSON extension contracts passed/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
