import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { Position } from '../../../../common/core/position.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { LanguageFeaturesService } from '../../../../common/services/languageFeaturesService.js';
import type { LanguageParameterHints, LanguageParameterHintsRequest } from '../../../../common/languages.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
browserEnvironment.window.HTMLCanvasElement.prototype.getContext = () => null;
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	ResizeObserver: class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	},
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}
await import('../../browser/parameterHints.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');
suiteTeardown(() => browserEnvironment.window.close());

const hints: LanguageParameterHints = {
	signatures: [{ label: 'call(value)', parameters: [{ label: 'value' }], activeParameter: 0 }],
};

test('signature actions follow provider availability, language and model attachment', async () => {
	using fixture = createEditor();
	const action = fixture.editor.getAction('editor.action.triggerParameterHints');
	assert.ok(action);
	const context = fixture.editor.invokeWithinContext(accessor => accessor.get(IContextKeyService));
	const read = () => [action.isSupported(), context.getValue('editorHasSignatureHelpProvider')];
	assert.deepEqual(read(), [false, false]);
	using provider = fixture.features.signatureHelpProvider.register('typescript', { provideParameterHints: () => hints });
	assert.deepEqual(read(), [true, true]);
	fixture.model.setLanguage('plaintext');
	assert.deepEqual(read(), [false, false]);
	fixture.model.setLanguage('typescript');
	fixture.editor.updateOptions({ readOnly: true });
	await action.run();
	assert.equal(fixture.dialog.hidden, false);
	fixture.editor.setModel(null);
	assert.deepEqual(read(), [false, false]);
	fixture.editor.setModel(fixture.model);
	assert.deepEqual(read(), [true, true]);
	provider.dispose();
	assert.deepEqual(read(), [false, false]);
});

test('signature commands switch the returned result without querying or moving the cursor', async () => {
	using fixture = createEditor();
	let calls = 0;
	using provider = fixture.features.signatureHelpProvider.register('typescript', {
		provideParameterHints: () => {
			calls++;
			return { signatures: [...hints.signatures, { label: 'call(other)', parameters: [{ label: 'other' }], activeParameter: 0 }] };
		},
	});
	await fixture.invoke();
	const nodes = [...fixture.dialog.children];
	const before = fixture.editor.getSelections();
	fixture.editor.trigger('test', 'showNextParameterHint', {});
	assert.equal(fixture.dialog.querySelector('.stanza-editor-parameter-hints-signature.active')?.textContent, 'call(other)');
	assert.deepEqual([...fixture.dialog.children], nodes);
	fixture.editor.trigger('test', 'showNextParameterHint', {});
	assert.equal(fixture.dialog.querySelector('.stanza-editor-parameter-hints-signature.active')?.textContent, 'call(value)');
	fixture.editor.trigger('test', 'showPrevParameterHint', {});
	assert.equal(fixture.dialog.querySelector('.stanza-editor-parameter-hints-signature.active')?.textContent, 'call(other)');
	assert.deepEqual(fixture.editor.getSelections(), before);
	assert.equal(calls, 1);
	fixture.editor.trigger('test', 'closeParameterHints', {});
	assert.equal(fixture.dialog.hidden, true);
	const context = fixture.editor.invokeWithinContext(accessor => accessor.get(IContextKeyService));
	assert.deepEqual([context.getValue('parameterHintsVisible'), context.getValue('parameterHintsMultipleSignatures')], [false, false]);
});

test('signature help uses the editor snapshot and stops after the first usable provider', async () => {
	using fixture = createEditor();
	const requests: LanguageParameterHintsRequest[] = [];
	using unused = fixture.features.signatureHelpProvider.register('typescript', {
		provideParameterHints: () => { throw new Error('Lower priority provider was called'); },
	});
	using owner = fixture.features.signatureHelpProvider.register('typescript', {
		provideParameterHints: (request, signal) => {
			assert.equal(signal, request.signal);
			requests.push(request);
			return hints;
		},
	});
	await fixture.invoke();
	assert.equal(requests.length, 1);
	const request = requests[0]!;
	assert.equal(request.model, fixture.model);
	assert.equal(request.resource, fixture.model.uri);
	assert.deepEqual({
		text: request.snapshot.getText(), version: request.snapshot.version,
		position: request.position.toString(), language: request.languageId, context: request.context,
	}, {
		text: 'call(', version: fixture.model.version,
		position: '(1,6)', language: 'typescript', context: { kind: 'invoke', isRetrigger: false },
	});
	assert.equal(fixture.dialog.hidden, false);
	assert.equal(fixture.dialog.querySelector('.active')?.textContent, 'call(value)');
	assert.equal(fixture.dialog.querySelector('strong')?.textContent, 'value');
	assert.deepEqual(fixture.errors, []);
});

for (const result of ['empty', 'throw', 'invalid label', 'invalid signature index', 'invalid parameter index'] as const) {
	test(`a provider returning ${result} does not block another signature provider`, async () => {
		using fixture = createEditor();
		using healthy = fixture.features.signatureHelpProvider.register('typescript', { provideParameterHints: () => hints });
		using first = fixture.features.signatureHelpProvider.register('typescript', {
			provideParameterHints: () => {
				if (result === 'throw') {
					throw new Error('Signature provider failed');
				}
				if (result === 'empty') {
					return { signatures: [] };
				}
				if (result === 'invalid label') {
					return { signatures: [{ label: 42, parameters: [] }] } as unknown as LanguageParameterHints;
				}
				if (result === 'invalid signature index') {
					return { ...hints, activeSignature: 2 };
				}
				return { signatures: [{ ...hints.signatures[0]!, activeParameter: -1 }] };
			},
		});
		await fixture.invoke();
		assert.equal(fixture.dialog.textContent, 'call(value)');
		assert.equal(fixture.errors.length, result === 'empty' ? 0 : 1);
	});
}

test('signature help can be enabled after an initially disabled editor is created', async () => {
	using fixture = createEditor(false);
	let calls = 0;
	using provider = fixture.features.signatureHelpProvider.register('typescript', {
		provideParameterHints: () => {
			calls++;
			return hints;
		},
	});
	await fixture.invoke();
	assert.equal(calls, 0);
	fixture.editor.updateOptions({ parameterHints: { enabled: true }, readOnly: true });
	await fixture.invoke();
	assert.equal(calls, 1);
	assert.equal(fixture.dialog.hidden, false);
	fixture.editor.updateOptions({ parameterHints: { enabled: false } });
	assert.equal(fixture.dialog.hidden, true);
});

test('disposing a model cancels signature help before trying another provider', async () => {
	using fixture = createEditor();
	let release!: () => void;
	const pending = new Promise<void>(resolve => { release = resolve; });
	let signal: AbortSignal | undefined;
	let laterCalls = 0;
	using later = fixture.features.signatureHelpProvider.register('typescript', {
		provideParameterHints: () => {
			laterCalls++;
			return hints;
		},
	});
	using first = fixture.features.signatureHelpProvider.register('typescript', {
		provideParameterHints: async (_request, cancellation) => {
			signal = cancellation;
			await pending;
			return undefined;
		},
	});
	try {
		await fixture.invoke();
		fixture.model.dispose();
		assert.equal(signal?.aborted, true);
		release();
		await flushPromises();
		assert.equal(laterCalls, 0);
		assert.equal(fixture.dialog.isConnected, false);
		assert.deepEqual(fixture.errors, []);
	} finally {
		release();
	}
});

function createEditor(enabled = true) {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const model = new TextModel('call(', { languageId: 'typescript' });
	const features = new LanguageFeaturesService();
	const errors: unknown[] = [];
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	const editor = createTestCodeEditor({
		container, model, ariaLabel: 'test.ts',
		languageFeaturesService: features, dimension: { width: 400, height: 120 },
		parameterHints: { enabled }, onLanguageError: error => errors.push(error),
	});
	editor.setPosition(new Position(1, 6));
	const input = container.querySelector<HTMLElement>('.stanza-editor-input')!;
	const dialog = container.querySelector<HTMLElement>('.stanza-editor-parameter-hints')!;
	return {
		model, features, editor, dialog, errors,
		invoke: async () => {
			editor.focus();
			input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ', ctrlKey: true, shiftKey: true }));
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
