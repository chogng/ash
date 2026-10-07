import assert from "node:assert/strict";
import { test } from "mocha";
import { PdfAnnotationModel } from "../../../../../workbench/contrib/pdf/browser/pdfAnnotationModel.js";
import { emptyPdfAnnotationDocument } from "../../../../../workbench/contrib/pdf/common/pdfAnnotations.js";

test("PDF annotation model tracks mutations, undo/redo, and the saved revision", () => {
	const model = new PdfAnnotationModel();
	model.restore({ document: emptyPdfAnnotationDocument(), revision: "initial" });
	const highlight = model.addHighlight(1, { x: 0.1, y: 0.2, width: 0.3, height: 0.15 }, "#f6c945", new Date("2026-08-08T00:00:00.000Z"));

	assert.equal(model.isDirty, true);
	assert.equal(model.canUndo, true);
	assert.equal(model.annotations[0]?.id, highlight.id);
	model.undo();
	assert.equal(model.annotations.length, 0);
	assert.equal(model.canRedo, true);
	model.redo();
	assert.equal(model.annotations[0]?.kind, "highlight");
	model.markSaved({ document: model.snapshot, revision: "saved" });
	assert.equal(model.isDirty, false);
	assert.equal(model.revision, "saved");
	model.dispose();
});

test("PDF annotation model updates and removes selected notes without changing other annotations", () => {
	const model = new PdfAnnotationModel();
	model.restore({ document: emptyPdfAnnotationDocument(), revision: undefined });
	const note = model.addNote(2, { x: 0.4, y: 0.5 }, "First draft", "#ff0000", new Date("2026-08-08T00:00:00.000Z"));
	model.updateNote(note.id, "Reviewed", new Date("2026-08-08T00:01:00.000Z"));

	assert.deepEqual(model.annotations.map((annotation) => annotation.kind === "note" ? annotation.text : undefined), ["Reviewed"]);
	model.remove(note.id);
	assert.equal(model.annotations.length, 0);
	model.undo();
	assert.equal(model.annotations[0]?.kind, "note");
	model.dispose();
});
