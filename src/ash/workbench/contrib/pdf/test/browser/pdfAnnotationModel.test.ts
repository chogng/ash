import assert from 'node:assert/strict';
import { test } from 'mocha';
import { PdfAnnotationModel } from '../../../../../../../extensions/pdf-viewer/browser/pdfAnnotationModel.js';
import { emptyPdfAnnotationDocument } from '../../../../../../../extensions/pdf-viewer/common/pdfAnnotations.js';

test('PDF annotation model tracks mutations, undo/redo, and the saved revision', () => {
	const model = new PdfAnnotationModel();
	model.restore({ document: emptyPdfAnnotationDocument(), revision: 'initial' });
	const highlight = model.addHighlight(1, { x: 0.1, y: 0.2, width: 0.3, height: 0.15 }, '#f6c945', new Date('2026-08-08T00:00:00.000Z'));

	assert.equal(model.isDirty, true);
	assert.equal(model.canUndo, true);
	assert.equal(model.annotations[0]?.id, highlight.id);
	model.undo();
	assert.equal(model.annotations.length, 0);
	assert.equal(model.canRedo, true);
	model.redo();
	assert.equal(model.annotations[0]?.kind, 'highlight');
	model.markSaved({ document: model.snapshot, revision: 'saved' });
	assert.equal(model.isDirty, false);
	assert.equal(model.revision, 'saved');
	model.dispose();
});

test('PDF annotation model updates and removes selected notes without changing other annotations', () => {
	const model = new PdfAnnotationModel();
	model.restore({ document: emptyPdfAnnotationDocument(), revision: undefined });
	const note = model.addNote(2, { x: 0.4, y: 0.5 }, 'First draft', '#ff0000', new Date('2026-08-08T00:00:00.000Z'));
	model.updateNote(note.id, 'Reviewed', new Date('2026-08-08T00:01:00.000Z'));

	assert.deepEqual(model.annotations.map((annotation) => annotation.kind === 'note' ? annotation.text : undefined), ['Reviewed']);
	model.remove(note.id);
	assert.equal(model.annotations.length, 0);
	model.undo();
	assert.equal(model.annotations[0]?.kind, 'note');
	model.dispose();
});

for (const change of ['add', 'update', 'remove', 'undo', 'redo'] as const) {
	test(`PDF save acknowledgement preserves a later ${change} and its history`, () => {
		using model = new PdfAnnotationModel();
		model.restore({ document: emptyPdfAnnotationDocument(), revision: 'initial' });
		const note = model.addNote(1, { x: 0.4, y: 0.5 }, 'Saving', '#ff0000');
		if (change === 'redo') model.undo();
		const saving = model.snapshot;
		if (change === 'add') model.addInk(1, [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], '#ff0000');
		if (change === 'update') model.updateNote(note.id, 'Still editing');
		if (change === 'remove') model.remove(note.id);
		if (change === 'undo') model.undo();
		if (change === 'redo') model.redo();
		const current = model.snapshot;
		const history = { undo: model.canUndo, redo: model.canRedo };

		model.markSaved({ document: saving, revision: 'first-save' });

		assert.deepEqual(model.snapshot, current);
		assert.equal(model.isDirty, true);
		assert.equal(model.revision, 'first-save');
		assert.deepEqual({ undo: model.canUndo, redo: model.canRedo }, history);
		if (change === 'undo') {
			model.redo();
		} else {
			model.undo();
		}
		assert.deepEqual(model.snapshot, saving);
		assert.equal(model.isDirty, false);
		if (change === 'undo') {
			model.undo();
		} else {
			model.redo();
		}
		assert.deepEqual(model.snapshot, current);
		assert.equal(model.isDirty, true);
		model.markSaved({ document: current, revision: 'second-save' });
		assert.equal(model.isDirty, false);
		assert.equal(model.revision, 'second-save');
	});
}

test('PDF save acknowledgement recognizes edits undone back to the saved content', () => {
	using model = new PdfAnnotationModel();
	model.addNote(1, { x: 0.4, y: 0.5 }, 'Saving', '#ff0000');
	const saving = model.snapshot;
	model.addHighlight(1, { x: 0.1, y: 0.2, width: 0.3, height: 0.1 }, '#ff0000');
	model.undo();
	model.markSaved({ document: saving, revision: 'saved' });
	assert.deepEqual(model.snapshot, saving);
	assert.equal(model.isDirty, false);
	assert.equal(model.canRedo, true);
	model.redo();
	assert.equal(model.annotations.length, 2);
	assert.equal(model.isDirty, true);
});
