import type { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import '../../../../editor/test/browser/testEditorDom.js';
import { getEditorFeatures } from '../../../../editor/browser/editorFeatures.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { Range } from '../../../../editor/common/core/range.js';
import { EditorExtensionsRegistry } from '../../../../editor/browser/editorExtensions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { MainThreadClientEditors } from '../../browser/mainThreadClientEditors.js';
import type { IExtensionApi } from '../../../../platform/extensions/common/extensionApi.js';
import type { IExtensionHostApi } from '../../../../platform/agentHost/common/extensionHostApi.js';

suite('Client-owned Code features', () => {
	test('local feature composition preserves existing text, version and undo without a provider', () => {
		using model = new TextModel('alpha');
		model.pushEditOperations(null, [{ range: new Range(1, 6, 1, 6), text: ' beta' }], () => null);
		const version = model.getVersionId();
		const source = model.tokenization.renderedTokens;
		using features = EditorExtensionsRegistry.registerEditorFeatures(getEditorFeatures());
		for (const id of [
			'editor.contrib.placeholderText',
			'editor.contrib.folding',
			'editor.contrib.suggestController',
			'editor.contrib.renameController',
		]) {
			assert.ok(EditorExtensionsRegistry.getSomeEditorContributions([id]).length, id);
		}
		assert.ok(CommandsRegistry.getCommand('editor.action.rename'));
		assert.equal(model.getText(), 'alpha beta');
		assert.equal(model.getVersionId(), version);
		assert.strictEqual(model.tokenization.renderedTokens, source);
		model.undo();
		assert.equal(model.getText(), 'alpha');
	});

	test('extension host retirement cannot withdraw built-in editor features', async () => {
		using features = EditorExtensionsRegistry.registerEditorFeatures(getEditorFeatures());
		let requests = 0;
		using bridge = new MainThreadClientEditors(
			30_000,
			async () => {
				throw new Error('No extension module should load');
			},
			{
				invoke: async () => {
					requests++;
					throw new Error('No provider should run');
				},
			} as unknown as IExtensionHostApi,
			{ list: async () => ({ generation: 1, extensions: [], diagnostics: [] }) } as unknown as IExtensionApi,
			emptyEditorDeclarations,
		);
		for (let generation = 1; generation <= 4; generation++) {
			await bridge.update({ generation, extensions: [] });
			bridge.clear();
			assert.ok(CommandsRegistry.getCommand('editor.action.rename'));
			assert.equal(EditorExtensionsRegistry.getSomeEditorContributions(['editor.contrib.folding']).length, 1);
		}
		assert.equal(requests, 0);
	});
});

const emptyEditorDeclarations = { getExtensionPointContributions: () => [] } as unknown as IExtensionService;
