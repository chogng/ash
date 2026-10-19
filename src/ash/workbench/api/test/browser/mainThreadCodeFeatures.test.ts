import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import '../../../../editor/test/browser/testEditorDom.js';
import manifest from '../../../../../../extensions/code/package.json' with { type: 'json' };
import { startCodeExtension } from '../../../../../../test/fixtures/codeExtension.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { Range } from '../../../../editor/common/core/range.js';
import { EditorExtensionsRegistry } from '../../../../editor/browser/editorExtensions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import type { ExtensionDescriptor } from '../../../../platform/extensions/common/extensionApi.js';
import type { IExtensionApi } from '../../../../platform/extensions/common/extensionApi.js';
import type { ExtensionHostRuntime, IExtensionHostApi } from '../../../../platform/agentHost/common/extensionHostApi.js';
import { MainThreadClientEditors } from '../../browser/mainThreadClientEditors.js';

const codeModule = await import('../../../../../../extensions/code/browser/editor.js');

const owner = { id: 'ash.code', name: 'code', publisher: 'ash', version: '1.0.0', sourceKind: 'builtIn', packageSha256: 'b'.repeat(64), manifestJson: JSON.stringify(manifest) } as ExtensionDescriptor;
const runtime: ExtensionHostRuntime = {
	id: owner.id, version: owner.version, packageDigest: `sha256:${'b'.repeat(64)}`, runtimeApiVersion: 1,
	activationGeneration: 1, incarnation: 1, lifecycle: 'ready', failure: undefined, stderr: '', outputEvents: [],
	registrations: [{ kind: 'dataChannel', channelId: 'editor.contributions.v1', registrationId: 'editor.contributions.v1' }],
};

suite('Independent Rust Code provider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('real capability activates every feature and retires without replacing text, version or undo', async function () {
		this.timeout(120_000);
		const process = await startCodeExtension();
		try {
			using model = new TextModel('alpha');
			model.pushEditOperations(null, [{ range: new Range(1, 6, 1, 6), text: ' beta' }], () => null);
			const version = model.getVersionId();
			const source = model.tokenization.renderedTokens;
			assert.equal(model.tokenization.semanticTokens, undefined);
			let loads = 0;
			using bridge = new MainThreadClientEditors(30_000, async () => {
				loads++;
				return codeModule;
			}, { invoke: (request, signal) => process.invoke(request.registrationId, request.operation, request.payload, signal) } as IExtensionHostApi,
				{ list: async () => ({ generation: 1, extensions: [owner], diagnostics: [] }) } as unknown as IExtensionApi);
			for (let generation = 1; generation <= 4; generation++) {
				await bridge.update({ generation: generation * 2, extensions: [{ ...runtime, registrations: process.registrations }] });
				const ids = EditorExtensionsRegistry.getEditorContributions().map(value => value.id);
				for (const id of ['editor.contrib.placeholderText', 'editor.contrib.folding', 'editor.contrib.suggestController', 'editor.contrib.renameController']) assert.ok(ids.includes(id), id);
				assert.ok(CommandsRegistry.getCommand('editor.action.rename'));
				assert.equal(model.getText(), 'alpha beta');
				assert.equal(model.getVersionId(), version);
				assert.strictEqual(model.tokenization.renderedTokens, source);
				await bridge.update({ generation: generation * 2 + 1, extensions: [] });
				assert.equal(EditorExtensionsRegistry.getSomeEditorContributions(ids).length, 0);
				assert.equal(CommandsRegistry.getCommand('editor.action.rename'), undefined);
				assert.strictEqual(model.tokenization.renderedTokens, source);
				assert.equal(model.getVersionId(), version);
			}
			assert.equal(loads, 4);
			model.undo();
			assert.equal(model.getText(), 'alpha');
		} finally { await process.dispose(); }
	});
	test('a module loaded after provider retirement cannot publish commands or model analysis', async () => {
		let finish!: (value: import('../../../services/extensions/browser/extensionEditor.js').ExtensionEditorClientModule) => void;
		let started!: () => void;
		const loading = new Promise<void>(resolve => { started = resolve; });
		using bridge = new MainThreadClientEditors(30_000, () => { started(); return new Promise(resolve => { finish = resolve; }); }, {
			invoke: async () => ({ version: 1, clientModule: 'browser/editor.ts', clientDigest: `sha256:${'a'.repeat(64)}` }),
		} as unknown as IExtensionHostApi, { list: async () => ({ generation: 1, extensions: [owner], diagnostics: [] }) } as unknown as IExtensionApi);
		const pending = bridge.update({ generation: 1, extensions: [runtime] });
		await Promise.race([loading, pending.then(() => { throw new Error("Provider did not request its module"); })]);
		bridge.clear();
		finish(codeModule);
		await pending;
		assert.equal(CommandsRegistry.getCommand('editor.action.rename'), undefined);
		assert.equal(EditorExtensionsRegistry.getSomeEditorContributions(['editor.contrib.folding']).length, 0);
	});
});
