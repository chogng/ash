import { registerTestCodeEditorFeatures } from '../../../../../test/fixtures/codeEditorFeatures.js';
import { after as afterCodeFeatures } from 'mocha';
import './testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { TextModel } from '../../common/model/textModel.js';
import { TextDecorationCollection } from '../../common/model/decorationCollection.js';
import { Range } from '../../common/core/range.js';
import { EndOfLineSequence } from '../../common/model.js';
import { UnusualLineTerminatorsController } from '../../contrib/unusualLineTerminators/browser/unusualLineTerminatorsController.js';
import { findUnusualLineTerminators } from '../../contrib/unusualLineTerminators/common/unusualLineTerminatorRanges.js';

test('unusual separators follow batches, Unicode columns, EOL changes and undo without rescanning the model', async () => {
	using model = new TextModel('😀a\u0085\r\nb\u2028c\r\ntail');
	using marks = new TextDecorationCollection<void>(model);
	let updating = false;
	using before = model.onDidChangeContent(() => updating = true);
	using controller = new UnusualLineTerminatorsController(model, marks);
	assert.equal(model.lineCount, 3);
	assert.equal(marks.size, 2);
	using after = model.onDidChangeContent(() => updating = false);
	const original = model.getLineContent, snapshot = model.createSnapshot;
	model.getLineContent = function (line) { assert.equal(updating, false, 'input must not read every document line'); return original.call(this, line); };
	model.createSnapshot = function (preserveBOM) { assert.equal(updating, false, 'input must not rescan a snapshot'); return snapshot.call(this, preserveBOM); };
	const check = (): void => assert.deepEqual(marks.decorations.map(mark => mark.range.toString()).sort(), findUnusualLineTerminators(model).map(range => range.toString()).sort());
	try {
		check();
		model.applyOperations([{ range: new Range(1, 1, 1, 1), text: '\u2029\r\n' }, { range: new Range(2, 2, 2, 3), text: 'x\u0085' }]);
		check();
		await model.undo(); check();
		await model.redo(); check();
		model.setEOL(EndOfLineSequence.LF); check();
		model.applyOperations([{ range: model.getFullModelRange(), text: 'clean\n\u2028end' }]); check();
		assert.equal(marks.size, 1);
		await model.undo(); check();
	} finally {
		model.getLineContent = original;
		model.createSnapshot = snapshot;
	}
});

const codeFeatures = registerTestCodeEditorFeatures();
afterCodeFeatures(() => codeFeatures.dispose());
