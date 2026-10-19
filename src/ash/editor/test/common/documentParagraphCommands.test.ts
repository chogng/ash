import { DocumentTextModel } from '../../../../../extensions/academic/common/model/documentTextModel.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { allSelection, textSelection } from '../../../../../extensions/academic/common/core/documentSelection.js';
import { createSetParagraphFormatCommand, createSetParagraphStyleCommand, getSelectedDocumentParagraphs } from '../../../../../extensions/academic/common/commands/documentParagraphCommands.js';
import { createSplitBlockCommand } from '../../../../../extensions/academic/common/commands/documentCommands.js';
import { createDefaultDocumentSchema } from '../../../../../extensions/academic/common/model/documentSchema.js';
import { TextModel } from '../../common/model/textModel.js';
import { deserializeDocument, serializeDocument } from '../../../../../extensions/academic/common/model/documentSerialization.js';
import { createAcademicDocumentSchema, createEmptyAcademicDocument } from '../../../../../extensions/academic/browser/contrib/academic/common/schema.js';

test('Paragraph formatting is one reversible transaction with shared line semantics and durable measurements', () => {
	const schema = createDefaultDocumentSchema();
	const document = schema.createDocument(['one', 'two', 'three'].map((text, index) => schema.createNode('paragraph', {
		id: `p${index}`, content: [schema.createText(text, { id: `t${index}`, marks: [{ type: 'strong', attrs: {} }] })],
	})));
	const selection = textSelection({ nodeId: 't1', offset: 2 }, { nodeId: 't0', offset: 1 });
	using model = DocumentTextModel.create(schema, document, { selection });
	const version = model.getVersionId();
	const command = createSetParagraphFormatCommand(model.document, 'p1', selection, { textAlign: 'center', lineSpacing: 2, spaceBefore: 6, spaceAfter: 12 });
	assert.ok(command);
	model.dispatch(command.transaction);
	assert.equal(model.getVersionId(), version + 1);
	assert.deepEqual(model.selection, selection);
	assert.deepEqual(model.document.content.map(node => node.attrs), [
		{ textAlign: 'center', lineSpacing: 2, spaceBefore: 6, spaceAfter: 12 },
		{ textAlign: 'center', lineSpacing: 2, spaceBefore: 6, spaceAfter: 12 }, {},
	]);
	assert.ok(model.lineDocument.facets.values.some(facet => facet.attrs.lineSpacing === 2));
	assert.deepEqual(deserializeDocument(serializeDocument(model.document, schema), schema), model.document);
	model.undoBlocks();
	assert.deepEqual(model.document, document);
	model.redoBlocks();
	assert.equal(model.document.content[1]!.attrs.spaceAfter, 12);
	assert.deepEqual(model.document.content[0]!.content[0]!.marks, [{ type: 'strong', attrs: {} }]);
	assert.equal(createSetParagraphFormatCommand(model.document, 'p0', selection, { textAlign: 'center' }), undefined);
});

test('Paragraph selection excludes the final start boundary in both directions and includes nested table cells', () => {
	const schema = createDefaultDocumentSchema();
	const first = schema.createNode('paragraph', { id: 'p1', content: [schema.createText('one', { id: 't1' })] });
	const second = schema.createNode('paragraph', { id: 'p2', content: [schema.createText('two', { id: 't2' })] });
	const table = schema.createNode('table', { content: [schema.createNode('tableRow', { content: [schema.createNode('tableCell', { content: [second] })] })] });
	const document = schema.createDocument([first, table]);
	for (const selection of [textSelection({ nodeId: 't1', offset: 1 }, { nodeId: 't2', offset: 0 }), textSelection({ nodeId: 't2', offset: 0 }, { nodeId: 't1', offset: 1 })]) {
		assert.deepEqual(getSelectedDocumentParagraphs(document, 'p1', selection).map(node => node.id), ['p1']);
	}
	assert.deepEqual(getSelectedDocumentParagraphs(document, 'p1', allSelection()).map(node => node.id), ['p1', 'p2']);
});

test('Built-in paragraph styles preserve identities, inline marks, direct formatting and split inheritance', () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode('paragraph', { id: 'p', attrs: { textAlign: 'center', spaceAfter: 18 }, content: [schema.createText('Hello', { id: 't', marks: [{ type: 'em', attrs: {} }] })] });
	using model = DocumentTextModel.create(schema, schema.createDocument([paragraph]));
	const heading = createSetParagraphStyleCommand(schema, model.document, 'p', undefined, 3);
	assert.ok(heading);
	model.dispatch(heading.transaction);
	assert.deepEqual(model.document.content[0]!.attrs, { textAlign: 'center', spaceAfter: 18, level: 3 });
	assert.equal(model.document.content[0]!.id, 'p');
	assert.equal(model.document.content[0]!.content[0]!.id, 't');
	assert.deepEqual(model.document.content[0]!.content[0]!.marks, paragraph.content[0]!.marks);
	const split = createSplitBlockCommand(schema, model.document, 'p', 't', 2);
	assert.ok(split);
	model.dispatch(split.transaction);
	assert.deepEqual(model.document.content[1]!.attrs, model.document.content[0]!.attrs);
	model.undoBlocks();
	const normal = createSetParagraphStyleCommand(schema, model.document, 'p', undefined, 0);
	assert.ok(normal);
	model.dispatch(normal.transaction);
	assert.equal(model.document.content[0]!.type, 'paragraph');
	assert.deepEqual(model.document.content[0]!.attrs, paragraph.attrs);
});

test('Academic mandatory headings reject structural conversion without modifying other selected paragraphs', () => {
	const schema = createAcademicDocumentSchema();
	const document = createEmptyAcademicDocument(schema);
	using model = DocumentTextModel.create(schema, document);
	const heading = document.content[0]!.content[0]!;
	assert.equal(createSetParagraphStyleCommand(schema, document, heading.id, allSelection(), 0), undefined);
	assert.deepEqual(model.document, document);
	const level = createSetParagraphStyleCommand(schema, document, heading.id, undefined, 2);
	assert.ok(level);
	model.dispatch(level.transaction);
	assert.equal(model.document.content[0]!.content[0]!.attrs.level, 2);
});

test('Invalid persisted paragraph measurements reject atomically and retain the previous model version', () => {
	const schema = createDefaultDocumentSchema();
	const document = schema.createDocument([schema.createNode('paragraph', { id: 'p' })]);
	using model = DocumentTextModel.create(schema, document);
	const version = model.getVersionId();
	for (const attrs of [{ lineSpacing: 0 }, { lineSpacing: Infinity }, { spaceBefore: -1 }, { spaceAfter: 145 }, { textAlign: 'invalid' }]) {
		const malformed = { ...document, content: [{ ...document.content[0]!, attrs }] };
		assert.throws(() => deserializeDocument({ format: 'ash.document', version: 2, documentType: 'general', document: malformed }, schema));
	}
	const command = createSetParagraphFormatCommand(document, 'p', undefined, { spaceAfter: -1 });
	assert.ok(command);
	assert.throws(() => model.dispatch(command.transaction));
	assert.equal(model.getVersionId(), version);
	assert.deepEqual(model.document, document);
	assert.equal(model.canUndoBlocks, false);
});
