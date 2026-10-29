import { documentPageDimensions } from '../../../../../extensions/academy/common/model/documentPageLayout.js';
import {
	createSplitBlockCommand,
	createSplitListItemCommand,
} from '../../../../../extensions/academy/common/commands/documentCommands.js';
import {
	serializeDocumentTransaction,
	deserializeDocumentTransaction,
} from '../../../../../extensions/academy/common/model/documentTransactionSerialization.js';
import type { DocumentAttributes } from '../../../../../extensions/academy/common/model/document.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { createDefaultDocumentSchema } from '../../../../../extensions/academy/common/model/documentSchema.js';
import { DocumentTextModel } from '../../../../../extensions/academy/common/model/documentTextModel.js';
import { DocumentTransaction } from '../../../../../extensions/academy/common/model/documentTransaction.js';
import {
	serializeDocument,
	deserializeDocument,
} from '../../../../../extensions/academy/common/model/documentSerialization.js';
import {
	createAcademyDocumentSchema,
	createEmptyAcademyDocument,
} from '../../../../../extensions/academy/browser/contrib/academy/common/schema.js';

for (const academy of [false, true]) {
	test(`Page settings validate, persist and undo atomically in ${academy ? 'Academy' : 'general'} documents`, () => {
		const schema = academy ? createAcademyDocumentSchema() : createDefaultDocumentSchema();
		const initial = academy
			? createEmptyAcademyDocument(schema)
			: schema.createDocument([schema.createNode('paragraph')]);
		using model = DocumentTextModel.create(schema, initial);
		const version = model.getVersionId();
		for (const attrs of [
			{ pageSize: 'unknown' },
			{ pageMargin: '72' },
			{ pageMargin: 0 },
			{ pageMargin: 145 },
			{ pageMargin: NaN },
		] as readonly DocumentAttributes[]) {
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

for (const academy of [false, true]) {
	test(`Pagination intent rejects invalid files and remote changes without advancing ${academy ? 'Academy' : 'general'} history`, () => {
		const schema = academy ? createAcademyDocumentSchema() : createDefaultDocumentSchema();
		const paragraph = schema.createNode('paragraph', {
			id: 'body',
			content: [schema.createText('正文😀', { id: 'text' })],
		});
		const initial = schema.createDocument([paragraph]);
		using model = DocumentTextModel.create(schema, initial);
		const version = model.getVersionId();
		for (const attrs of [
			{ pageOrientation: 'sideways' },
			{ pageHeader: 'a\nb' },
			{ pageFooter: 'x'.repeat(501) },
			{ pageNumbers: 'yes' },
			{ pageDifferentFirst: 1 },
			{ pageDifferentEven: null },
		] as readonly DocumentAttributes[]) {
			assert.throws(() =>
				deserializeDocument(
					JSON.stringify({
						format: 'ash.document',
						version: 2,
						documentType: schema.documentType,
						document: { ...initial, attrs },
					}),
					schema,
				),
			);
			assert.throws(() => model.dispatchRemote(new DocumentTransaction().setNodeAttributes(initial.id, attrs)));
		}
		for (const key of ['pageBreakBefore', 'keepTogether', 'keepWithNext', 'widowControl']) {
			assert.throws(() =>
				model.dispatch(
					new DocumentTransaction()
						.replaceText('text', 0, 2, 'changed')
						.setNodeAttributes('body', { [key]: 'true' }),
				),
			);
		}
		assert.deepEqual(model.document, initial);
		assert.equal(model.getVersionId(), version);
		assert.equal(model.canUndoBlocks, false);
	});
}

test('Pagination properties survive the collaboration wire, save, undo and redo with one model version', () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode('paragraph', {
		id: 'body',
		content: [schema.createText('text', { id: 'text' })],
	});
	const initial = schema.createDocument([paragraph]);
	using model = DocumentTextModel.create(schema, initial);
	const transaction = new DocumentTransaction()
		.setNodeAttributes(initial.id, {
			pageSize: 'letter',
			pageOrientation: 'landscape',
			pageMargin: 36,
			pageHeader: '研究',
			pageFooter: 'draft',
			pageNumbers: true,
			pageDifferentFirst: true,
			pageDifferentEven: true,
			pageEvenHeader: 'even',
			pageEvenFooter: '',
		})
		.setNodeAttributes('body', {
			pageBreakBefore: true,
			keepWithNext: true,
			keepTogether: true,
			widowControl: false,
		});
	model.dispatch(deserializeDocumentTransaction(serializeDocumentTransaction(transaction, schema), schema));
	assert.equal(model.getVersionId(), 2);
	const saved = model.document;
	assert.deepEqual(deserializeDocument(serializeDocument(saved, schema), schema), saved);
	const dimensions = documentPageDimensions(saved)!;
	assert.equal(dimensions.width, 11 * 96);
	assert.equal(dimensions.height, 8.5 * 96);
	model.undoBlocks();
	assert.deepEqual(model.document, initial);
	model.redoBlocks();
	assert.deepEqual(model.document, saved);
});

test('Enter keeps the original manual page boundary without propagating it to the new paragraph or list item', () => {
	const schema = createDefaultDocumentSchema();
	for (const list of [false, true]) {
		const paragraph = schema.createNode('paragraph', {
			id: `p${list}`,
			attrs: { pageBreakBefore: true, keepTogether: true },
			content: [schema.createText('left右', { id: `t${list}` })],
		});
		const item = schema.createNode('listItem', { content: [paragraph] });
		const initial = schema.createDocument(
			list ? [schema.createNode('bulletList', { content: [item] })] : [paragraph],
		);
		using model = DocumentTextModel.create(schema, initial);
		const command = list
			? createSplitListItemCommand(schema, initial, item.id, paragraph.id, `t${list}`, 4)
			: createSplitBlockCommand(schema, initial, paragraph.id, `t${list}`, 4);
		assert.ok(command);
		model.dispatch(command.transaction);
		const paragraphs = list
			? model.document.content[0]!.content.map(item => item.content[0]!)
			: model.document.content;
		assert.deepEqual(
			paragraphs.map(node => node.attrs),
			[{ pageBreakBefore: true, keepTogether: true }, { keepTogether: true }],
		);
		assert.deepEqual(
			paragraphs.map(node => node.content[0]?.text),
			['left', '右'],
		);
		model.undoBlocks();
		assert.deepEqual(model.document, initial);
	}
});
