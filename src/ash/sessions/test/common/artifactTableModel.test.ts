import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ArtifactTableModel } from '../../contrib/artifact/common/artifactTableModel.js';

test('Artifact table rectangular edits expand one model and preserve a minimum row and column', () => {
	let saves = 0;
	const model = new ArtifactTableModel('table', 'sheet', [['original']], undefined, () => saves++);
	model.setCells(0, 1, [['a', 'b'], ['c', 'd']]);
	assert.deepEqual(model.rows, [['original', 'a', 'b'], ['', 'c', 'd']]);
	assert.equal(saves, 1);
	model.deleteRow(0);
	model.deleteColumn(1);
	assert.deepEqual(model.rows, [['', 'd']]);
	model.deleteColumn(0);
	const revision = model.version.get();
	model.deleteRow(0);
	model.deleteColumn(0);
	assert.deepEqual(model.rows, [['d']]);
	assert.equal(model.version.get(), revision);
	assert.equal(saves, 4);
});
