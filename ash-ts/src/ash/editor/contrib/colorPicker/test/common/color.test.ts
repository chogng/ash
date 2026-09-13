import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { TextModel } from '../../../../common/model/textModel.js';
import { LanguageFeatureRegistry } from '../../../../common/languageFeatureRegistry.js';
import { ColorService, type LanguageColorProvider } from '../../common/languageColors.js';

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
