import '../../../../test/browser/testEditorDom.js';
import type { LanguageColorProvider } from '../../../../common/languages.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { LanguageFeatureRegistry } from '../../../../common/languageFeatureRegistry.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { ColorService } from '../../common/languageColors.js';
import { ColorDetector } from '../../browser/colorDetector.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { LanguageFeaturesService } from '../../../../common/services/languageFeaturesService.js';
import type { ColorPickerController } from '../../browser/colorPickerController.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { builtinLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';

await import('../../browser/colorPickerContribution.js');
await import('../../../hover/browser/hoverContribution.js');
const { CodeEditorWidget } = await import('../../../../browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor } = await import('../../../../test/browser/testCodeEditor.js');

test('color hover waits for the committed color presentation and rejects it after closing', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeDom = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('#f00');
	using features = new LanguageFeaturesService();
	const requests: { signal: AbortSignal; complete: () => void }[] = [];
	using registration = features.colorProvider.register('*', {
		provideDocumentColors: () => [{ range: new Range(1, 1, 1, 5), color: { red: 1, green: 0, blue: 0, alpha: 1 } }],
		provideColorPresentations: (request, signal) => new Promise(resolve => requests.push({ signal, complete: () => resolve([{ label: request.color.green > 0.5 ? '#00ff00' : '#ff0000', textEdit: { range: request.range, text: request.color.green > 0.5 ? '#00ff00' : '#ff0000' } }]) })),
	});
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model, languageFeaturesService: features });
	editor.layout({ width: 500, height: 160 });
	await waitFor(() => dom.window.document.querySelector('.colorpicker-color-decoration') !== null);
	editor.setPosition(new Position(1, 2));
	editor.focus();
	await editor.getAction('editor.action.showHover')!.run();
	await waitFor(() => requests.length === 1);
	requests[0]!.complete();
	const picker = dom.window.document.querySelector<HTMLElement>('.stanza-editor-color-picker.hover')!;
	assert.equal(picker.parentElement!.getAttribute('aria-label'), 'Editor hover');
	await waitFor(() => picker.querySelector<HTMLSelectElement>('select')?.value === '#ff0000');
	const hue = picker.querySelector<HTMLInputElement>('.ash-color-picker-hue')!;
	hue.focus();
	assert.equal(dom.window.document.querySelector('.stanza-editor-accessibility-status')!.textContent, 'Press Alt+F1 for color picker help.');
	hue.value = '120';
	hue.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	hue.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
	assert.equal(model.getText(), '#f00');
	requests[1]!.complete();
	await waitFor(() => model.getText() === '#00ff00');
	assert.equal(picker.hidden, false);
	requests[2]!.complete();
	await waitFor(() => picker.querySelector<HTMLSelectElement>('select')?.value === '#00ff00');
	hue.value = '0';
	hue.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	hue.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
	editor.getContribution<ColorPickerController>('editor.contrib.colorPicker')!.hide();
	assert.equal(requests[3]!.signal.aborted, true);
	requests[3]!.complete();
	await new Promise<void>(resolve => queueMicrotask(resolve));
	assert.equal(model.getText(), '#00ff00');
	model.undo();
	assert.equal(model.getText(), '#f00');
});


test('color picker decorates, edits, and undoes a CSS color as one operation', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeDom = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	using model = new TextModel('const color = #ff000080;');
	const errors: unknown[] = [];
	using editor = createTestCodeEditor({
		container,
		ariaLabel: 'colors.css',
		model,
		onLanguageError: error => errors.push(error),
	});
	editor.layout({ width: 500, height: 160 });

	await waitFor(() => container.querySelector('.colorpicker-color-decoration') !== null);
	const swatch = container.querySelector<HTMLElement>('.colorpicker-color-decoration')!;
	assert.match(swatch.className, /dyn-rule-/u);
	editor.setPosition(new Position(1, 16));
	editor.focus();
	editor.view.controller.element.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
		key: 'c', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
	}));

	const dialog = dom.window.document.querySelector<HTMLElement>('.stanza-editor-color-picker')!;
	await waitFor(() => !dialog.hidden && dialog.querySelector('.stanza-editor-color-picker-presentation')?.querySelectorAll('option').length === 3);
	const hue = dialog.querySelector<HTMLInputElement>('.ash-color-picker-hue')!;
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
		ariaLabel: 'tracked.css',
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
			container, model,
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
		assert.equal(dom.window.document.querySelector('.stanza-editor-color-picker:not([hidden])'), null);
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

test('color picker disables old edits while a provider resolves the latest color and preserves its chosen format', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeDom = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('red; extra', { languageId: 'css' });
	using features = new LanguageFeaturesService();
	let complete!: () => void;
	let requestCount = 0;
	using registration = features.colorProvider.register('*', {
		provideDocumentColors: () => [{ range: new Range(1, 1, 1, 4), color: { red: 1, green: 0, blue: 0, alpha: 1 } }],
		provideColorPresentations: request => {
			const green = request.color.green > 0.5;
			const values = [{ label: green ? 'green' : 'red' }, {
				label: green ? 'GREEN' : 'RED',
				textEdit: { range: request.range, text: green ? 'GREEN' : 'RED' },
				additionalTextEdits: [{ range: new Range(1, 6, 1, 11), text: 'updated' }],
			}];
			if (requestCount++ === 0) { return values; }
			return new Promise(resolve => { complete = () => resolve(values); });
		},
	});
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	const errors: unknown[] = [];
	using editor = createTestCodeEditor({ container, model, languageFeaturesService: features, onLanguageError: error => errors.push(error) });
	editor.layout({ width: 500, height: 160 });
	const controller = editor.getContribution<ColorPickerController>('editor.contrib.colorPicker')!;
	await controller.showAtPosition(new Position(1, 2));
	const dialog = dom.window.document.querySelector<HTMLElement>('.stanza-editor-color-picker')!;
	const formats = dialog.querySelector<HTMLSelectElement>('.stanza-editor-color-picker-presentation')!;
	formats.selectedIndex = 1;
	formats.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
	const hue = dialog.querySelector<HTMLInputElement>('.ash-color-picker-hue')!;
	hue.value = '120';
	hue.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	assert.equal(dialog.querySelector<HTMLButtonElement>('.stanza-editor-color-picker-apply')!.disabled, true);
	controller.insertColor();
	assert.equal(model.getValue(), 'red; extra');
	complete();
	await waitFor(() => formats.value === 'GREEN');
	controller.insertColor();
	assert.equal(model.getValue(), 'GREEN; updated');
	model.undo();
	assert.equal(model.getValue(), 'red; extra');
	assert.deepEqual(errors, []);
});

test('color picker translates its shared controls and exposes help and current color in Chinese', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeDom = toDisposable(() => dom.window.close());
	using restoreLanguage = toDisposable(() => resetNlsResolver());
	setNlsMessages('zh-CN', builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('#f00');
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model });
	editor.layout({ width: 500, height: 160 });
	await editor.getContribution<ColorPickerController>('editor.contrib.colorPicker')!.showAtPosition(new Position(1, 2));
	const dialog = dom.window.document.querySelector<HTMLElement>('.stanza-editor-color-picker')!;
	assert.equal(dialog.getAttribute('aria-label'), '颜色选择器');
	const area = dialog.querySelector<HTMLElement>('.ash-color-picker-area')!;
	assert.equal(area.getAttribute('aria-label'), '饱和度和亮度');
	area.focus();
	for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
		const implementation = AccessibleViewRegistry.getImplementations().find(candidate => candidate.name === `editorColorPicker${type}`)!;
		using provider = editor.invokeWithinContext(accessor => implementation.getProvider(accessor))!;
		assert.match(provider.provideContent(), type === AccessibleViewType.Help ? /方向键/u : /写入文档的值：#ff0000/u);
	}
});

test('color picker guesses the document format from the first current result after an early color change', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using closeDom = toDisposable(() => dom.window.close());
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('#f00');
	using features = new LanguageFeaturesService();
	const requests: { signal: AbortSignal; complete: () => void }[] = [];
	using registration = features.colorProvider.register('*', {
		provideDocumentColors: () => [{ range: new Range(1, 1, 1, 5), color: { red: 1, green: 0, blue: 0, alpha: 1 } }],
		provideColorPresentations: (request, signal) => new Promise(resolve => requests.push({
			signal,
			complete: () => resolve([{ label: `rgb(0, ${Math.round(request.color.green * 255)}, 0)` }, { label: request.color.green > 0.5 ? '#00ff00' : '#ff0000' }]),
		})),
	});
	using editor = createTestCodeEditor({ container: dom.window.document.querySelector<HTMLElement>('main')!, model, languageFeaturesService: features });
	editor.layout({ width: 500, height: 160 });
	const pending = editor.getContribution<ColorPickerController>('editor.contrib.colorPicker')!.showAtPosition(new Position(1, 2));
	await waitFor(() => requests.length === 1);
	const dialog = dom.window.document.querySelector<HTMLElement>('.stanza-editor-color-picker')!;
	const hue = dialog.querySelector<HTMLInputElement>('.ash-color-picker-hue')!;
	hue.value = '120';
	hue.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	assert.equal(requests[0]!.signal.aborted, true);
	requests[1]!.complete();
	await waitFor(() => dialog.querySelector<HTMLSelectElement>('.stanza-editor-color-picker-presentation')!.value === '#00ff00');
	requests[0]!.complete();
	await pending;
	assert.equal(dialog.querySelector<HTMLSelectElement>('.stanza-editor-color-picker-presentation')!.value, '#00ff00');
});
