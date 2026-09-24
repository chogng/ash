import '../../../../test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Range } from '../../../../common/core/range.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { LanguageFeaturesService } from '../../../../common/services/languageFeaturesService.js';
import type { LanguageRenameRequest, LanguageWorkspaceEdit } from '../../../../common/languages.js';

await import('../../browser/rename.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
const { registerEditorContribution } = await import('../../../../browser/editorExtensions.js');
const commandLogs = new WeakMap<TextModel, string[]>();
registerEditorContribution({
	id: 'test.renameCommandObserver',
	install: context => {
		if (context.kind !== 'text') return;
		return context.onDidExecuteCommand(event => commandLogs.get(context.model)?.push(event.commandId));
	},
});

test('rename keeps the provider that prepared the symbol and reports one undoable command', async () => {
	using fixture = createEditor();
	const { model, features, input, commands, errors } = fixture;
	let preparation: LanguageRenameRequest | undefined;
	using owner = features.renameProvider.register('typescript', {
		prepareRename: request => {
			preparation = request;
			return { range: model.getFullModelRange(), placeholder: 'value' };
		},
		provideRenameEdits: (request, signal) => {
			assert.ok(preparation);
			assert.equal(request.snapshot, preparation.snapshot);
			assert.equal(request.position, preparation.position);
			assert.equal(request.resource, model.uri);
			assert.equal(signal, preparation.signal);
			assert.equal(request.newName, 'result');
			return { entries: [{ kind: 'textDocument', resource: model.uri, edits: [{ range: model.getFullModelRange(), text: request.newName! }] }] };
		},
	});
	using unrelated = features.renameProvider.register('typescript', {
		prepareRename: () => undefined,
		provideRenameEdits: () => { throw new Error('Wrong rename provider'); },
	});
	await fixture.open();
	input.value = 'result';
	fixture.press(input, 'Enter');
	await flushPromises();
	assert.deepEqual({ text: model.getValue(), commands, errors }, { text: 'result', commands: ['editor.action.rename'], errors: [] });
	model.undo();
	assert.equal(model.getValue(), 'value');
});

test('a provider without optional preparation renames the word at the cursor', async () => {
	using fixture = createEditor();
	using provider = fixture.features.renameProvider.register('typescript', {
		provideRenameEdits: request => ({ entries: [{ kind: 'textDocument', resource: request.resource, edits: [{ range: fixture.model.getFullModelRange(), text: request.newName! }] }] }),
	});
	await fixture.open();
	assert.equal(fixture.input.value, 'value');
	fixture.input.value = 'next';
	fixture.press(fixture.input, 'Enter');
	await flushPromises();
	assert.equal(fixture.model.getValue(), 'next');
	assert.deepEqual(fixture.errors, []);
});

for (const failure of ['throw', 'invalid range'] as const) {
	test(`a preparation ${failure} is reported without blocking another provider`, async () => {
		using fixture = createEditor();
		using healthy = fixture.features.renameProvider.register('typescript', {
			prepareRename: () => ({ range: fixture.model.getFullModelRange(), placeholder: 'value' }),
			provideRenameEdits: () => ({ entries: [] }),
		});
		using broken = fixture.features.renameProvider.register('typescript', {
			prepareRename: () => {
				if (failure === 'throw') throw new Error('Preparation failed');
				return { range: new Range(1, 1, 1, 20), placeholder: 'invalid' };
			},
			provideRenameEdits: () => { throw new Error('Invalid provider selected'); },
		});
		await fixture.open();
		assert.equal(fixture.input.value, 'value');
		assert.equal(fixture.errors.length, 1);
	});
}

for (const mismatch of ['version', 'expectedText'] as const) {
	test(`a rename edit with a mismatched ${mismatch} cannot change the model`, async () => {
		using fixture = createEditor();
		using provider = fixture.features.renameProvider.register('typescript', {
			provideRenameEdits: request => ({ entries: [{
				kind: 'textDocument', resource: request.resource,
				...(mismatch === 'version' ? { version: request.snapshot.version + 1 } : { expectedText: 'outdated' }),
				edits: [{ range: fixture.model.getFullModelRange(), text: 'wrong' }],
			}] }),
		});
		await fixture.open();
		fixture.input.value = 'result';
		fixture.press(fixture.input, 'Enter');
		await flushPromises();
		assert.equal(fixture.model.getValue(), 'value');
		assert.equal(fixture.errors.length, 1);
		assert.equal(fixture.input.readOnly, false);
	});
}

for (const outcome of ['complete', 'error'] as const) {
	test(`a dispatched rename can ${outcome} without closing a newer input session`, async () => {
		let release!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		const edits: LanguageWorkspaceEdit[] = [];
		using fixture = createEditor(async edit => {
			edits.push(edit);
			await pending;
			if (outcome === 'error') throw new Error('Workspace rename failed');
		});
		using provider = fixture.features.renameProvider.register('typescript', {
			provideRenameEdits: request => ({ entries: [{ kind: 'textDocument', resource: request.resource, edits: [{ range: fixture.model.getFullModelRange(), text: request.newName! }] }] }),
		});
		try {
			await fixture.open();
			fixture.input.value = 'result';
			fixture.press(fixture.input, 'Enter');
			fixture.press(fixture.input, 'Enter');
			await flushPromises();
			assert.equal(edits.length, 1);
			fixture.press(fixture.input, 'Escape');
			await fixture.open();
			fixture.input.value = 'new session';
			release();
			await flushPromises();
			assert.equal(fixture.input.value, 'new session');
			assert.equal(fixture.input.closest<HTMLElement>('.stanza-editor-rename')!.hidden, false);
			assert.deepEqual(fixture.errors.map(error => (error as Error).message), outcome === 'error' ? ['Workspace rename failed'] : []);
		} finally {
			release();
		}
	});
}

function createEditor(onApplyWorkspaceEdit?: (edit: LanguageWorkspaceEdit) => Promise<void>) {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const model = new TextModel('value', { languageId: 'typescript' });
	const features = new LanguageFeaturesService();
	const errors: unknown[] = [];
	const commands: string[] = [];
	commandLogs.set(model, commands);
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	const editor = createTestCodeEditor({
		container, model, ariaLabel: 'test.ts',
		languageFeaturesService: features, dimension: { width: 320, height: 100 }, onLanguageError: error => errors.push(error),
		...(onApplyWorkspaceEdit ? { onApplyWorkspaceEdit } : {}),
	});
	const editorInput = container.querySelector<HTMLElement>('.stanza-editor-input')!;
	const input = container.querySelector<HTMLInputElement>('.stanza-editor-rename-input')!;
	const press = (target: HTMLElement, key: string): void => {
		target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }));
	};
	return {
		model, features, editor, input, errors, commands, press,
		open: async () => {
			editor.focus();
			press(editorInput, 'F2');
			await flushPromises();
		},
		[Symbol.dispose]: () => {
			editor.dispose();
			features.dispose();
			model.dispose();
			dom.window.close();
		},
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}
