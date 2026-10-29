import assert from 'node:assert/strict';
import { test } from 'mocha';
import { createDefaultDocumentSchema } from '../../../../../extensions/academy/common/model/documentSchema.js';
import { DocumentTextModel } from '../../../../../extensions/academy/common/model/documentTextModel.js';
import { DocumentTransaction } from '../../../../../extensions/academy/common/model/documentTransaction.js';
import { createCommentCommand, createResolveRevisionCommand } from '../../../../../extensions/academy/common/model/documentReview.js';
import { createDocumentSectionCommand, createRemoveSectionCommand } from '../../../../../extensions/academy/common/model/documentSections.js';
import { textSelection } from '../../../../../extensions/academy/common/core/documentSelection.js';
import { serializeDocument, deserializeDocument, documentToPlainText } from '../../../../../extensions/academy/common/model/documentSerialization.js';

const schema = createDefaultDocumentSchema();
const paragraph = (id: string, text: string) => schema.createNode('paragraph', { id, content: [schema.createText(text, { id: id + '-text' })] });

test('Academy sections retain identities, text positions, history and persisted page intent', () => {
	const original = schema.createDocument([paragraph('a', 'Alpha'), paragraph('b', 'Beta'), paragraph('c', 'Gamma')]);
	using model = DocumentTextModel.create(schema, original);
	const command = createDocumentSectionCommand(schema, model.document, 'b')!;
	model.dispatch(command.transaction);
	const section = model.document.content[1]!;
	assert.equal(section.type, 'documentSection');
	assert.deepEqual(
		section.content.map(node => node.id),
		['b', 'c'],
	);
	assert.equal(model.getValue(), 'Alpha\nBeta\nGamma');
	model.dispatch(
		new DocumentTransaction().setNodeAttributes(section.id, {
			...section.attrs,
			pageSize: 'letter',
			pageOrientation: 'landscape',
			pageMargin: 54,
		}),
	);
	assert.deepEqual(deserializeDocument(serializeDocument(model.document, schema), schema), model.document);
	model.dispatch(createRemoveSectionCommand(model.document, 'b')!.transaction);
	assert.deepEqual(
		model.document.content.map(node => node.id),
		['a', 'b', 'c'],
	);
	model.undoBlocks();
	assert.equal(model.document.content[1]!.attrs.pageOrientation, 'landscape');
	model.undoBlocks();
	model.undoBlocks();
	assert.deepEqual(model.document, original);
	model.redoBlocks();
	assert.equal(model.document.content[1]!.content[0]!.id, 'b');
});

test('Academy comments map through edits and undo without entering the text projection', () => {
	using model = DocumentTextModel.create(schema, schema.createDocument([paragraph('a', 'Alpha')]));
	const selection = textSelection({ nodeId: 'a-text', offset: 1 }, { nodeId: 'a-text', offset: 4 });
	model.dispatch(createCommentCommand(schema, model.document, 'a', selection, 'Check this', 'Reader')!.transaction);
	const record = () => model.document.content.find(node => node.type === 'reviewComment')!;
	assert.equal(model.getValue(), 'Alpha');
	assert.equal(documentToPlainText(model.document, schema), 'Alpha');
	model.dispatch(new DocumentTransaction().replaceText('a-text', 0, 0, '中'));
	assert.deepEqual(JSON.parse(String(record().attrs.anchor)), textSelection({ nodeId: 'a-text', offset: 2 }, { nodeId: 'a-text', offset: 5 }));
	model.undoBlocks();
	assert.deepEqual(JSON.parse(String(record().attrs.anchor)), selection);
	model.redoBlocks();
	assert.equal(JSON.parse(String(record().attrs.anchor)).anchor.offset, 2);
	assert.deepEqual(deserializeDocument(serializeDocument(model.document, schema), schema), model.document);
});

test('Academy block revisions coalesce evidence and accept/reject through the same undo history', () => {
	using model = DocumentTextModel.create(schema, schema.createDocument([paragraph('a', 'Alpha')]));
	model.dispatch(new DocumentTransaction().withMeta('review.control', true).setNodeAttributes(model.document.id, { trackChanges: true }));
	model.dispatch(new DocumentTransaction().withMeta('review.author', 'Writer').replaceText('a-text', 0, 5, 'Beta'));
	model.dispatch(new DocumentTransaction().replaceText('a-text', 4, 4, '!'));
	let records = model.document.content.filter(node => node.type === 'reviewChange');
	assert.equal(records.length, 1);
	assert.equal(records[0]!.attrs.author, 'Writer');
	assert.equal(model.getValue(), 'Beta!');
	model.dispatch(createResolveRevisionCommand(schema, model.document, records[0]!.id, false, 'a')!.transaction);
	assert.equal(model.getValue(), 'Alpha');
	assert.equal(model.document.content.length, 1);
	model.undoBlocks();
	assert.equal(model.getValue(), 'Beta!');
	records = model.document.content.filter(node => node.type === 'reviewChange');
	model.dispatch(createResolveRevisionCommand(schema, model.document, records[0]!.id, true, 'a')!.transaction);
	assert.equal(model.getValue(), 'Beta!');
	assert.equal(model.document.content.length, 1);
	model.undoBlocks();
	assert.equal(model.document.content.filter(node => node.type === 'reviewChange').length, 1);
});

test('Academy rejects malformed review data and nested sections at the schema boundary', () => {
	assert.throws(() =>
		schema.createNode('reviewComment', {
			attrs: {
				author: 'a',
				createdAt: '',
				body: 'x',
				quote: '',
				resolved: false,
				anchor: '{"kind":"text","anchor":{"nodeId":"a","offset":-1}}',
			},
		}),
	);
	const inner = schema.createNode('documentSection', { content: [paragraph('a', 'Alpha')] });
	assert.throws(() => schema.validate({ ...schema.createDocument(), content: [{ ...inner, content: [inner] }] }));
});

test('Academy copy and replacement cross section boundaries without page-local identities', async () => {
	const { documentSelectionToText, extractDocumentFragment } = await import('../../../../../extensions/academy/common/model/documentSerialization.js');
	const { createReplaceTextCommand } = await import('../../../../../extensions/academy/common/commands/documentCommands.js');
	const document = schema.createDocument([paragraph('a', 'Alpha'), schema.createNode('documentSection', { content: [paragraph('b', 'Beta'), paragraph('c', 'Gamma')] })]);
	const selection = textSelection({ nodeId: 'a-text', offset: 2 }, { nodeId: 'c-text', offset: 3 });
	assert.equal(documentSelectionToText(document, selection), 'pha\nBeta\nGam');
	assert.equal(extractDocumentFragment(schema, document, selection)!.content.length, 3);
	using model = DocumentTextModel.create(schema, document);
	model.dispatch(createReplaceTextCommand(schema, document, 'a', selection, 'X')!.transaction);
	assert.equal(model.getValue(), 'AlXma');
	assert.equal(model.document.content.length, 1);
	model.undoBlocks();
	assert.deepEqual(model.document, document);
});

test('Academy rebases a new comment over peer typing and preserves peer edits on review acceptance', async () => {
	const { rebaseDocumentTransaction } = await import('../../../../../extensions/academy/common/contrib/collaboration/rebase.js');
	const document = schema.createDocument([paragraph('a', 'Alpha')]);
	const local = createCommentCommand(schema, document, 'a', textSelection({ nodeId: 'a-text', offset: 1 }, { nodeId: 'a-text', offset: 4 }), 'Peer comment', 'Reader')!.transaction;
	const remote = new DocumentTransaction().replaceText('a-text', 0, 0, '中');
	const rebased = rebaseDocumentTransaction(document, schema, local, remote);
	const comment = rebased.document.content.find(node => node.type === 'reviewComment')!;
	assert.equal(JSON.parse(String(comment.attrs.anchor)).anchor.offset, 2);
	using model = DocumentTextModel.create(schema, { ...rebased.document, attrs: { trackChanges: true } });
	model.dispatch(new DocumentTransaction().replaceText('a-text', 6, 6, '!'));
	const change = model.document.content.find(node => node.type === 'reviewChange')!;
	model.dispatch(createResolveRevisionCommand(schema, model.document, change.id, true, 'a')!.transaction);
	assert.equal(model.getValue(), '中Alpha!');
	model.undoBlocks();
	assert.equal(model.getValue(), '中Alpha!');
});

test('Academy structural revisions promote related block baselines into one reversible review unit', () => {
	const original = {
		...schema.createDocument([paragraph('a', 'Alpha'), paragraph('b', 'Beta')]),
		attrs: { trackChanges: true },
	};
	using model = DocumentTextModel.create(schema, original);
	model.dispatch(new DocumentTransaction().replaceText('b-text', 0, 4, 'Changed'));
	model.dispatch(createDocumentSectionCommand(schema, model.document, 'b')!.transaction);
	const records = model.document.content.filter(node => node.type === 'reviewChange');
	assert.equal(records.length, 1);
	assert.equal(records[0]!.attrs.scope, 'structure');
	model.dispatch(new DocumentTransaction().replaceText('b-text', 7, 7, '!'));
	model.dispatch(createResolveRevisionCommand(schema, model.document, records[0]!.id, false, 'b')!.transaction);
	assert.deepEqual(model.document, original);
	model.undoBlocks();
	assert.equal(model.getValue(), 'Alpha\nChanged!');
	assert.equal(model.document.content[1]!.type, 'documentSection');
});

test('Academy comment positions survive marked-run replacement and restore exactly on undo', async () => {
	const { createToggleMarkCommand } = await import('../../../../../extensions/academy/common/commands/documentCommands.js');
	using model = DocumentTextModel.create(schema, schema.createDocument([paragraph('a', 'Alpha')]));
	const selection = textSelection({ nodeId: 'a-text', offset: 1 }, { nodeId: 'a-text', offset: 4 });
	model.dispatch(createCommentCommand(schema, model.document, 'a', selection, 'Review', 'Reader')!.transaction);
	model.dispatch(createToggleMarkCommand(schema, model.document, 'a', 'a-text', selection, 'strong')!.transaction);
	const comment = model.document.content.find(node => node.type === 'reviewComment')!;
	const mapped = JSON.parse(String(comment.attrs.anchor));
	const { documentSelectionToText } = await import('../../../../../extensions/academy/common/model/documentSerialization.js');
	assert.equal(documentSelectionToText(model.document, mapped), 'lph');
	model.undoBlocks();
	assert.deepEqual(JSON.parse(String(model.document.content[1]!.attrs.anchor)), selection);
});

test('Academy reviews a style definition and its new references atomically', () => {
	const original = { ...schema.createDocument([paragraph('a', 'Alpha')]), attrs: { trackChanges: true } };
	using model = DocumentTextModel.create(schema, original);
	model.dispatch(
		new DocumentTransaction()
			.setNodeAttributes(original.id, {
				...original.attrs,
				paragraphStyles: JSON.stringify([{ id: 'new-style', name: 'New style', level: 0, attrs: { fontSize: 15 } }]),
			})
			.setNodeAttributes('a', { styleId: 'new-style' }),
	);
	const revision = model.document.content.find(node => node.type === 'reviewChange')!;
	assert.equal(revision.attrs.scope, 'structure');
	model.dispatch(createResolveRevisionCommand(schema, model.document, revision.id, false, 'a')!.transaction);
	assert.deepEqual(model.document, original);
});

test('Academy multiline paste across sections retains the destination section and its page intent', async () => {
	const { createPasteTextCommand } = await import('../../../../../extensions/academy/common/commands/documentCommands.js');
	const document = schema.createDocument([
		schema.createNode('documentSection', {
			id: 'first-section',
			attrs: { pageSize: 'letter' },
			content: [paragraph('a', 'Alpha')],
		}),
		schema.createNode('documentSection', { content: [paragraph('b', 'Beta')] }),
	]);
	using model = DocumentTextModel.create(schema, document);
	model.dispatch(createPasteTextCommand(schema, document, 'a', textSelection({ nodeId: 'a-text', offset: 2 }, { nodeId: 'b-text', offset: 2 }), 'One\nTwo')!.transaction);
	assert.equal(model.getValue(), 'AlOne\nTwota');
	assert.equal(model.document.content.length, 1);
	assert.equal(model.document.content[0]!.id, 'first-section');
	assert.equal(model.document.content[0]!.content.length, 2);
	model.undoBlocks();
	assert.deepEqual(model.document, document);
});
