import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { LanguageFeatureRegistry } from '../../../../common/languageFeatureRegistry.js';
import { ColorService, DefaultDocumentColorProvider } from '../../common/languageColors.js';
import { type LanguageColorProvider, createLanguageFeatureRequest } from '../../../../common/languages.js';

test('presentation queries aggregate providers without requiring document color detection and honor default enablement', async () => {
	using model = new TextModel('token');
	const providers = new LanguageFeatureRegistry<LanguageColorProvider>();
	const range = new Range(1, 1, 1, 6);
	const color = { red: 0, green: 1, blue: 0, alpha: 1 };
	const signal = new AbortController().signal;
	const service = new ColorService(model, providers);
	using first = providers.register('*', { provideDocumentColors: () => [], provideColorPresentations: () => [{ label: 'first' }] });
	using second = providers.register('*', { provideDocumentColors: () => [], provideColorPresentations: () => [{ label: 'second' }] });
	assert.deepEqual((await service.provideColorPresentationsFromProviders('plaintext', range, color, 'auto', signal)).map(value => value.label), ['second', 'first']);
	assert.deepEqual((await service.provideColorPresentationsFromProviders('plaintext', range, color, 'always', signal)).map(value => value.label), ['second', 'first', 'rgb(0, 255, 0)', 'hsl(120, 100%, 50%)', '#00ff00']);
	first.dispose();
	second.dispose();
	assert.deepEqual(await service.provideColorPresentationsFromProviders('plaintext', range, color, 'never', signal), []);
});

test('presentation queries discard previously collected results when the document changes during a later provider', async () => {
	using model = new TextModel('token');
	const providers = new LanguageFeatureRegistry<LanguageColorProvider>();
	let complete!: () => void;
	using slow = providers.register('*', { provideDocumentColors: () => [], provideColorPresentations: () => new Promise(resolve => { complete = () => resolve([{ label: 'late' }]); }) });
	using fast = providers.register('*', { provideDocumentColors: () => [], provideColorPresentations: () => [{ label: 'early' }] });
	const pending = new ColorService(model, providers).provideColorPresentationsFromProviders('plaintext', new Range(1, 1, 1, 6), { red: 1, green: 0, blue: 0, alpha: 1 }, 'auto', new AbortController().signal);
	while (!complete) { await Promise.resolve(); }
	model.setValue('changed');
	complete();
	assert.deepEqual(await pending, []);
});

test('default document colors parse CSS hex, RGB, HSL, alpha, and presentations', async () => {
	using model = new TextModel('a:#f00; b:rgba(0, 128, 255, .5); c:hsl(120, 100%, 25%); d:#11223344; invalid:rgb(1, 2, 3, 4, 5);');
	const providers = new LanguageFeatureRegistry<LanguageColorProvider>();
	const service = new ColorService(model, providers);
	const signal = new AbortController().signal;

	const colors = await service.provideDocumentColors('css', 'auto', signal);

	assert.deepEqual(colors.map(data => ({
		text: model.getTextInRange(data.information.range),
		color: { r: Math.round(data.information.color.red * 255), g: Math.round(data.information.color.green * 255), b: Math.round(data.information.color.blue * 255), a: Math.round(data.information.color.alpha * 255) },
	})), [
		{ text: '#f00', color: { r: 255, g: 0, b: 0, a: 255 } },
		{ text: 'rgba(0, 128, 255, .5)', color: { r: 0, g: 128, b: 255, a: 128 } },
		{ text: 'hsl(120, 100%, 25%)', color: { r: 0, g: 128, b: 0, a: 255 } },
		{ text: '#11223344', color: { r: 17, g: 34, b: 51, a: 68 } },
	]);
	const presentations = await service.provideColorPresentations('css', colors[1]!, colors[1]!.information.color, signal);
	assert.deepEqual(presentations.map(presentation => presentation.label), [
		'rgba(0, 128, 255, 0.502)',
		'hsla(210, 100%, 50%, 0.502)',
		'#0080ff80',
	]);
});

test('explicit providers suppress the default provider in auto mode and retain presentation ownership', async () => {
	using model = new TextModel('const color = #f00;', { languageId: 'typescript' });
	const providers = new LanguageFeatureRegistry<LanguageColorProvider>();
	using registration = providers.register('typescript', {
		provideDocumentColors: () => [{
			range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (model.getLineContent((0) + 1).length) + 1)),
			color: { red: 1 / 255, green: 2 / 255, blue: 3 / 255, alpha: 1 },
		}],
		provideColorPresentations: request => [{ label: 'provider-color', textEdit: { range: request.range, text: 'provider-color' } }],
	});
	const service = new ColorService(model, providers);
	const signal = new AbortController().signal;

	const auto = await service.provideDocumentColors('typescript', 'auto', signal);
	const always = await service.provideDocumentColors('typescript', 'always', signal);

	assert.equal(auto.length, 1);
	assert.equal(always.length, 2);
	assert.deepEqual((await service.provideColorPresentations('typescript', auto[0]!, auto[0]!.information.color, signal)).map(value => value.label), ['provider-color']);
});

test('default color coordinates belong to the request snapshot after the model changes', () => {
	using model = new TextModel('😀\ncolor: #abcdef;');
	const signal = new AbortController().signal;
	const request = createLanguageFeatureRequest(model, 'css', signal);
	model.setValue('short');
	const colors = new DefaultDocumentColorProvider().provideDocumentColors(request, signal);
	assert.deepEqual(colors.map(color => color.range), [new Range(2, 8, 2, 15)]);
});

for (const change of ['content', 'language', 'dispose'] as const) {
	test(`color presentations discard provider failures after ${change}`, async () => {
		using model = new TextModel('#f00', { languageId: 'css' });
		const providers = new LanguageFeatureRegistry<LanguageColorProvider>();
		const errors: unknown[] = [];
		const service = new ColorService(model, providers, undefined, error => errors.push(error));
		const signal = new AbortController().signal;
		const [data] = await service.provideDocumentColors('css', 'auto', signal);
		let reject!: (error: Error) => void;
		const pending = new Promise<never>((_resolve, fail) => { reject = fail; });
		const provider: LanguageColorProvider = { provideDocumentColors: () => [], provideColorPresentations: () => pending };
		const result = service.provideColorPresentations('css', { ...data!, provider }, data!.information.color, signal);
		if (change === 'content') model.setValue('');
		else if (change === 'language') model.setLanguage('plaintext');
		else model.dispose();
		reject(new Error('Provider failed after invalidation'));
		assert.deepEqual(await result, []);
		assert.deepEqual(errors, []);
	});
}

test('an aborted default color request rejects even when there are no literals', () => {
	using model = new TextModel('plain text');
	const controller = new AbortController();
	const request = createLanguageFeatureRequest(model, 'plaintext', controller.signal);
	controller.abort();
	assert.throws(() => new DefaultDocumentColorProvider().provideDocumentColors(request, controller.signal), { name: 'AbortError' });
});

test('a provider without presentations never fabricates a document edit', async () => {
	using model = new TextModel('brandRed');
	const providers = new LanguageFeatureRegistry<LanguageColorProvider>();
	const errors: unknown[] = [];
	const service = new ColorService(model, providers, undefined, error => errors.push(error));
	using registration = providers.register('*', {
		provideDocumentColors: () => [{ range: new Range(1, 1, 1, 9), color: { red: 1, green: 0, blue: 0, alpha: 1 } }],
		provideColorPresentations: () => [],
	});
	const signal = new AbortController().signal;
	const [data] = await service.provideDocumentColors('plaintext', 'auto', signal);
	assert.deepEqual(await service.provideColorPresentations('plaintext', data!, data!.information.color, signal), []);
	assert.deepEqual(errors, []);
});
