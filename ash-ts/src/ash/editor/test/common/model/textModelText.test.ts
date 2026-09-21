import assert from 'node:assert/strict';
import { test } from 'mocha';
import { TextEdit } from '../../../common/core/edits/textEdit.js';
import { Range } from '../../../common/core/range.js';
import { OffsetRange } from '../../../common/core/ranges/offsetRange.js';
import { TextModel } from '../../../common/model/textModel.js';
import { TextModelText } from '../../../common/model/textModelText.js';

test('Model text reads current text and coordinates after edits and EOL changes', () => {
	using model = new TextModel('😀\r\nlast');
	const text = new TextModelText(model);
	const coordinates = text.getTransformer();
	assert.equal(text.getValueOfOffsetRange(new OffsetRange(4, 8)), 'last');
	model.applyEdits([{ range: new Range(1, 1, 1, 3), text: 'x\r\ny' }]);
	assert.deepEqual({ range: text.length.toRange(), lineLength: text.getLineLength(2), start: coordinates.getPosition(6) }, {
		range: new Range(1, 1, 3, 5), lineLength: 1, start: model.getPositionAt(6),
	});
	model.setEOL(0);
	assert.equal(text.getValueOfOffsetRange(new OffsetRange(4, 8)), 'last');
	assert.equal(TextEdit.replace(new Range(3, 1, 3, 5), 'end').apply(text), 'x\ny\nend');
});
