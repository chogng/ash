import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Color, RGBA } from '../../../../../base/common/color.js';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { ColorPickerModel } from '../../browser/colorPickerModel.js';

test('color picker model retains format choice while provider presentations refresh', () => {
	const range = Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (9) + 1));
	const presentations = ['rgba(255, 0, 0, 0.5)', 'hsla(0, 100%, 50%, 0.5)', '#ff000080'].map(label => ({ label, textEdit: { range, text: label } }));
	using model = new ColorPickerModel(new Color(new RGBA(255, 0, 0, 128 / 255)), presentations, 0);

	model.guessColorPresentation(model.color, '#ff000080');
	model.color = new Color(new RGBA(0, 255, 0, 128 / 255));
	model.colorPresentations = [
		{ label: 'rgba(0, 255, 0, 0.5)', textEdit: { range, text: 'rgba(0, 255, 0, 0.5)' } },
		{ label: 'hsla(120, 100%, 50%, 0.5)', textEdit: { range, text: 'hsla(120, 100%, 50%, 0.5)' } },
		{ label: '#00ff0080', textEdit: { range, text: '#00ff0080' } },
	];

	assert.equal(model.presentation.label, '#00ff0080');
	model.selectNextColorPresentation();
	assert.equal(model.presentation.label, 'rgba(0, 255, 0, 0.5)');
});
