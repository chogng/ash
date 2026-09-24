import type { LanguageColorProvider } from '../../../../common/languages.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { URI } from '../../../../../base/common/uri.js';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { LanguageFeatureRegistry } from '../../../../common/languageFeatureRegistry.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { ColorService } from '../../common/languageColors.js';
import { ColorDetector } from '../../browser/colorDetector.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { LanguageFeaturesService } from '../../../../common/services/languageFeaturesService.js';
import type { ColorPickerController } from '../../browser/colorPickerController.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
browserEnvironment.window.HTMLCanvasElement.prototype.getContext = () => null;
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	InputEvent: browserEnvironment.window.InputEvent,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
	ResizeObserver: class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	},
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

await import('../../browser/colorPickerController.js');
const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');

suiteTeardown(() => browserEnvironment.window.close());

test('color picker decorates, edits, and undoes a CSS color as one operation', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeDom = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('const color = #ff000080;');
	const errors: unknown[] = [];
	using editor = createTestCodeEditor({
		container,
		input: { resource: URI.file('C:\\project\\colors.css'), label: 'colors.css' },
		languageId: 'css',
		model,
		onLanguageError: error => errors.push(error),
	});
	editor.layout({ width: 500, height: 160 });

	await waitFor(() => container.querySelector('.colorpicker-color-decoration') !== null);
	const swatch = container.querySelector<HTMLElement>('.colorpicker-color-decoration')!;
	assert.match(swatch.className, /dyn-rule-/u);
	swatch.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));

	const dialog = container.querySelector<HTMLElement>('.stanza-editor-color-picker')!;
	await waitFor(() => !dialog.hidden && dialog.querySelectorAll('option').length === 3);
	const hue = dialog.querySelector<HTMLInputElement>('.stanza-editor-color-picker-hue')!;
	hue.value = '120';
	hue.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	await waitFor(() => dialog.querySelector<HTMLSelectElement>('.stanza-editor-color-picker-presentation')?.value === '#00ff0080');
	const apply = dialog.querySelector<HTMLButtonElement>('.stanza-editor-color-picker-apply')!;
	apply.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
	assert.equal(dialog.hidden, false);
	apply.click();

	assert.equal(model.getText(), 'const color = #00ff0080;');
	model.undo();
	assert.equal(model.getText(), 'const color = #ff000080;');
	assert.deepEqual(errors, []);
});

test('color detector returns the tracked range before its debounced provider refresh', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeDom = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('#f00');
	using editor = createTestCodeEditor({
		container,
		input: { resource: URI.file('C:\\project\\tracked.css'), label: 'tracked.css' },
		languageId: 'css',
		model,
	});
	const providers = new LanguageFeatureRegistry<LanguageColorProvider>();
	const service = new ColorService(model, providers);
	using detector = new ColorDetector(editor, model, service, dom.window as unknown as Window, (error: unknown) => assert.fail(String(error)));
	detector.refresh();
	await waitFor(() => detector.totalColorCount === 1);

	model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: 'x' }]);
	const data = detector.getColorData(new Position((0) + 1, (2) + 1));

	assert.ok(data);
	assert.equal(model.getTextInRange(data.information.range), '#f00');
	assert.equal(detector.getColorData(new Position(1, 1)), null);
});

for (const change of ['language', 'provider', 'readOnly', 'dispose'] as const) {
	test(`color picker cancels presentations on ${change} and rejects late results`, async () => {
		const dom = new JSDOM('<!doctype html><body><main></main></body>');
		using closeDom = toDisposable(() => dom.window.close());
		dom.window.HTMLCanvasElement.prototype.getContext = () => null;
		const container = dom.window.document.querySelector<HTMLElement>('main')!;
		using model = new TextModel('#f00', { languageId: 'css' });
		using features = new LanguageFeaturesService();
		const languages: string[] = [];
		let finish!: () => void;
		let signal!: AbortSignal;
		using provider = features.colorProvider.register('*', {
			provideDocumentColors: request => {
				languages.push(request.languageId);
				return [{ range: new Range(1, 1, 1, 5), color: { red: 1, green: 0, blue: 0, alpha: 1 } }];
			},
			provideColorPresentations: (request, cancellation) => {
				languages.push(request.languageId);
				signal = cancellation;
				return new Promise(resolve => { finish = () => resolve([{ label: '#0f0' }]); });
			},
		});
		const errors: unknown[] = [];
		using editor = createTestCodeEditor({
			container, model, languageId: 'css', input: { resource: model.uri },
			languageFeaturesService: features, onLanguageError: error => errors.push(error),
		});
		editor.layout({ width: 500, height: 160 });
		model.setLanguage('scss');
		await waitFor(() => container.querySelector('.colorpicker-color-decoration') !== null);
		const controller = editor.getContribution<ColorPickerController>('editor.contrib.colorPicker')!;
		const pending = controller.showAtPosition(new Position(1, 2));
		await waitFor(() => signal !== undefined);
		assert.ok(languages.length >= 2);
		assert.ok(languages.every(language => language === 'scss'));
		if (change === 'language') model.setLanguage('less');
		if (change === 'provider') provider.dispose();
		if (change === 'readOnly') editor.updateOptions({ readOnly: true });
		if (change === 'dispose') editor.dispose();
		assert.equal(signal.aborted, true);
		if (change === 'language' || change === 'provider') {
			assert.equal(model.getAllDecorations().filter(decoration => decoration.options.description === 'colorDetector').length, 0);
		}
		finish();
		await pending;
		assert.equal(container.querySelector('.stanza-editor-color-picker:not([hidden])'), null);
		assert.equal(model.getValue(), '#f00');
		assert.deepEqual(errors, []);
	});
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	assert.fail('Timed out waiting for the color picker');
}
