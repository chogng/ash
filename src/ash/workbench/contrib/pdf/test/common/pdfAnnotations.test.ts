import assert from "node:assert/strict";
import { test } from "mocha";
import { emptyPdfAnnotationDocument, parsePdfAnnotationDocument, serializePdfAnnotationDocument } from "../../../../../workbench/contrib/pdf/common/pdfAnnotations.js";

test("PDF annotation documents round-trip through the versioned durable format", () => {
	const source = {
		version: 1,
		annotations: [{
			id: "note-1",
			kind: "note",
			page: 1,
			color: "#F6C945",
			createdAt: "2026-08-08T00:00:00.000Z",
			updatedAt: "2026-08-08T00:00:00.000Z",
			point: { x: 0.25, y: 0.5 },
			text: "Review this paragraph",
		}],
	} as const;

	const serialized = serializePdfAnnotationDocument(source);
	assert.match(serialized, /"version": 1/);
	assert.equal(serialized.endsWith("\n"), true);
	assert.deepEqual(parsePdfAnnotationDocument(serialized), {
		version: 1,
		annotations: [{
			...source.annotations[0],
			color: "#f6c945",
		}],
	});
});

test("PDF annotation parsing rejects malformed, duplicate, and out-of-page content", () => {
	assert.throws(() => parsePdfAnnotationDocument("not json"), SyntaxError);
	assert.throws(() => parsePdfAnnotationDocument(JSON.stringify({ version: 2, annotations: [] })), /Unsupported/);
	assert.throws(() => parsePdfAnnotationDocument(JSON.stringify({
		version: 1,
		annotations: [{
			id: "highlight-1",
			kind: "highlight",
			page: 1,
			color: "#f6c945",
			createdAt: "2026-08-08T00:00:00.000Z",
			updatedAt: "2026-08-08T00:00:00.000Z",
			rect: { x: 0.8, y: 0.2, width: 0.3, height: 0.1 },
		}],
	})), /inside its page bounds/);
	assert.throws(() => parsePdfAnnotationDocument(JSON.stringify({
		version: 1,
		annotations: [{
			id: "note-1",
			kind: "note",
			page: 1,
			color: "#f6c945",
			createdAt: "2026-08-08T00:00:00.000Z",
			updatedAt: "2026-08-08T00:00:00.000Z",
			point: { x: 0.2, y: 0.4 },
			text: "First",
		}, {
			id: "note-1",
			kind: "note",
			page: 1,
			color: "#f6c945",
			createdAt: "2026-08-08T00:00:00.000Z",
			updatedAt: "2026-08-08T00:00:00.000Z",
			point: { x: 0.3, y: 0.5 },
			text: "Second",
		}],
	})), /duplicate/);
});

test("empty PDF annotation documents are serializable immutable baselines", () => {
	const document = emptyPdfAnnotationDocument();
	assert.equal(Object.isFrozen(document), true);
	assert.equal(Object.isFrozen(document.annotations), true);
	assert.equal(serializePdfAnnotationDocument(document), "{\n  \"version\": 1,\n  \"annotations\": []\n}\n");
});
