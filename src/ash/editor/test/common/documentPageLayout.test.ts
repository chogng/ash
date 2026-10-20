import type { DocumentAttributes } from '../../../../../extensions/academic/common/model/document.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { createDefaultDocumentSchema } from '../../../../../extensions/academic/common/model/documentSchema.js';
import { DocumentTextModel } from '../../../../../extensions/academic/common/model/documentTextModel.js';
import { DocumentTransaction } from '../../../../../extensions/academic/common/model/documentTransaction.js';
import { serializeDocument, deserializeDocument } from '../../../../../extensions/academic/common/model/documentSerialization.js';
import { createAcademicDocumentSchema, createEmptyAcademicDocument } from '../../../../../extensions/academic/browser/contrib/academic/common/schema.js';

for (const academic of [false, true]) {
	test(`Page settings validate, persist and undo atomically in ${academic ? 'Academic' : 'general'} documents`, () => {
		const schema = academic ? createAcademicDocumentSchema() : createDefaultDocumentSchema();
		const initial = academic ? createEmptyAcademicDocument(schema) : schema.createDocument([schema.createNode('paragraph')]);
		using model = DocumentTextModel.create(schema, initial);
		const version = model.getVersionId();
		for (const attrs of ([{ pageSize: 'unknown' }, { pageMargin: '72' }, { pageMargin: 0 }, { pageMargin: 145 }, { pageMargin: NaN }] as readonly DocumentAttributes[])) {
			assert.throws(() => model.dispatch(new DocumentTransaction().setNodeAttributes(initial.id, attrs)));
			assert.deepEqual(model.document, initial);
			assert.equal(model.getVersionId(), version);
		}
		model.dispatch(new DocumentTransaction().setNodeAttributes(initial.id, { pageSize: 'a4', pageMargin: 54 }));
		assert.equal(model.getVersionId(), version + 1);
		assert.deepEqual(deserializeDocument(serializeDocument(model.document, schema), schema), model.document);
		assert.deepEqual(model.document.content, initial.content);
		model.undoBlocks();
		assert.deepEqual(model.document, initial);
		model.redoBlocks();
		assert.deepEqual(model.document.attrs, { pageSize: 'a4', pageMargin: 54 });
	});
}
