import { getDocumentParagraphStyles, resolveDocumentParagraphAttributes } from '../../../../../extensions/academic/common/model/documentParagraph.js';
import { createReplaceDocumentMatchesCommand, findDocumentText, getDocumentFindMatchIndex } from '../../../../../extensions/academic/common/commands/documentFindCommands.js';
import { DocumentTextModel } from '../../../../../extensions/academic/common/model/documentTextModel.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { allSelection, textSelection } from '../../../../../extensions/academic/common/core/documentSelection.js';
import { createApplyParagraphStyleCommand, createClearParagraphOverridesCommand, createDefineParagraphStyleCommand, createDeleteParagraphStyleCommand, createSetListNumberingCommand, getDocumentList, createSetParagraphFormatCommand, createSetParagraphStyleCommand, getSelectedDocumentParagraphs } from '../../../../../extensions/academic/common/commands/documentParagraphCommands.js';
import { createSplitBlockCommand, createInsertFragmentCommand, createSetBlockTypeCommand } from '../../../../../extensions/academic/common/commands/documentCommands.js';
import { createDefaultDocumentSchema } from '../../../../../extensions/academic/common/model/documentSchema.js';
import { TextModel } from '../../common/model/textModel.js';
import { deserializeDocument, serializeDocument, extractDocumentFragment, serializeDocumentFragment, deserializeDocumentFragment } from '../../../../../extensions/academic/common/model/documentSerialization.js';
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

test('Academy named styles retain references, direct overrides, inline marks and one-step history', () => {
	const schema = createDefaultDocumentSchema();
	const document = schema.createDocument(['one', 'two'].map((text, i) => schema.createNode('paragraph', { id: `p${i}`, content: [schema.createText(text, { id: `t${i}`, marks: [{ type: 'em', attrs: {} }] })] })));
	using model = DocumentTextModel.create(schema, document);
	model.dispatch(createSetParagraphFormatCommand(model.document, 'p0', undefined, { indentStart: 36, firstLineIndent: -18, fontFamily: 'serif', fontSize: 18 })!.transaction);
	model.dispatch(createDefineParagraphStyleCommand(model.document, 'p0', 'Essay')!.transaction);
	const styleId = getDocumentParagraphStyles(model.document)[0]!.id;
	assert.equal(model.document.content[0]!.attrs.styleId, styleId);
	assert.equal(Object.keys(model.document.content[0]!.attrs).length, 1);
	model.dispatch(createApplyParagraphStyleCommand(schema, model.document, 'p1', undefined, styleId)!.transaction);
	assert.equal(resolveDocumentParagraphAttributes(model.document, model.document.content[1]!).indentStart, 36);
	assert.equal(model.lineDocument.facets.values.find(facet => facet.attrs.nodeId === 'p1')!.attrs.indentStart, 36);
	model.dispatch(createSetParagraphFormatCommand(model.document, 'p1', undefined, { indentStart: 54 })!.transaction);
	model.dispatch(createSetParagraphFormatCommand(model.document, 'p0', undefined, { indentStart: 72 })!.transaction);
	model.dispatch(createDefineParagraphStyleCommand(model.document, 'p0', 'Updated essay', styleId)!.transaction);
	assert.equal(resolveDocumentParagraphAttributes(model.document, model.document.content[0]!).indentStart, 72);
	assert.equal(resolveDocumentParagraphAttributes(model.document, model.document.content[1]!).indentStart, 54);
	model.dispatch(createClearParagraphOverridesCommand(model.document, 'p1', undefined)!.transaction);
	assert.equal(resolveDocumentParagraphAttributes(model.document, model.document.content[1]!).indentStart, 72);
	model.undoBlocks();
	assert.equal(resolveDocumentParagraphAttributes(model.document, model.document.content[1]!).indentStart, 54);
	model.dispatch(createDeleteParagraphStyleCommand(model.document, 'p0', styleId)!.transaction);
	assert.equal(getDocumentParagraphStyles(model.document).length, 0);
	assert.equal(model.document.content[1]!.attrs.styleId, undefined);
	assert.equal(model.document.content[1]!.attrs.indentStart, 54);
	assert.equal(model.document.content[0]!.attrs.indentStart, 72);
	assert.deepEqual(model.document.content[1]!.content[0]!.marks, [{ type: 'em', attrs: {} }]);
	assert.deepEqual(deserializeDocument(serializeDocument(model.document, schema), schema), model.document);
	model.undoBlocks();
	assert.equal(model.document.content[0]!.attrs.styleId, styleId);
});

test('Academy rejects malformed style definitions, references, indents and numbering at persistence boundaries', () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode('paragraph', { id: 'p' });
	const document = schema.createDocument([paragraph]);
	const invalid = [
		{ ...document, attrs: { paragraphStyles: '{}' } },
		{ ...document, attrs: { paragraphStyles: 'not json' } },
		{ ...document, attrs: { paragraphStyles: JSON.stringify([{ id: 's', name: 'S', level: 0, attrs: { indentStart: -1 } }]) } },
		{ ...document, attrs: { paragraphStyles: JSON.stringify([{ id: 's', name: 'S', level: 7, attrs: {} }]) } },
		{ ...document, content: [{ ...paragraph, attrs: { styleId: 'missing' } }] },
		{ ...document, content: [{ ...paragraph, attrs: { indentStart: 721 } }] },
		{ ...document, content: [{ ...paragraph, attrs: { firstLineIndent: -145 } }] },
	];
	for (const value of invalid) assert.throws(() => deserializeDocument({ format: 'ash.document', version: 2, documentType: 'general', document: value }, schema));
	assert.throws(() => schema.createNode('orderedList', { attrs: { order: 0 }, content: [schema.createNode('listItem', { content: [paragraph] })] }));
	assert.throws(() => schema.createNode('orderedList', { attrs: { order: 1, numbering: 'bad' }, content: [schema.createNode('listItem', { content: [paragraph] })] }));
});

test('Academy numbering targets the innermost ordered list and persists in a reversible transaction', () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode('paragraph', { id: 'p', content: [schema.createText('Item')] });
	const inner = schema.createNode('orderedList', { id: 'inner', content: [schema.createNode('listItem', { content: [paragraph] })] });
	const outer = schema.createNode('orderedList', { id: 'outer', attrs: { order: 3 }, content: [schema.createNode('listItem', { content: [inner] })] });
	using model = DocumentTextModel.create(schema, schema.createDocument([outer]));
	model.dispatch(createSetListNumberingCommand(model.document, 'p', { order: 5, numbering: 'upper-roman' })!.transaction);
	assert.deepEqual(getDocumentList(model.document, 'p')!.attrs, { order: 5, numbering: 'upper-roman' });
	assert.equal(model.document.content[0]!.attrs.order, 3);
	assert.deepEqual(deserializeDocument(serializeDocument(model.document, schema), schema), model.document);
	model.undoBlocks();
	assert.deepEqual(getDocumentList(model.document, 'p')!.attrs, { order: 1 });
});

test('Academy rich search crosses marks, respects objects and Unicode boundaries, and replaces atomically', () => {
	const schema = createDefaultDocumentSchema();
	const first = schema.createNode('paragraph', { id: 'p', attrs: { indentStart: 18 }, content: [schema.createText('Hel', { id: 'a', marks: [{ type: 'strong', attrs: {} }] }), schema.createText('lo Hello 😀', { id: 'b', marks: [{ type: 'em', attrs: {} }] }), schema.createNode('image', { attrs: { src: 'https://example.com/x.png' } }), schema.createText('Hello', { id: 'c' })] });
	const code = schema.createNode('codeBlock', { id: 'code', content: [schema.createText('Hello Hello', { id: 'code-text' })] });
	const document = schema.createDocument([first, code]);
	const options = { matchCase: false, wholeWord: true };
	const matches = findDocumentText(document, 'hello', options);
	assert.equal(matches.length, 5);
	assert.equal(getDocumentFindMatchIndex(document, matches, matches[1]!.selection, 1), 2);
	assert.equal(getDocumentFindMatchIndex(document, matches, textSelection(matches[1]!.selection.head), 1, true), 2);
	assert.equal(getDocumentFindMatchIndex(document, matches, matches[0]!.selection, -1), 4);
	assert.deepEqual(matches[0]!.selection, textSelection({ nodeId: 'a', offset: 0 }, { nodeId: 'b', offset: 2 }));
	assert.equal(findDocumentText(document, 'hello', { ...options, matchCase: true }).length, 0);
	assert.equal(findDocumentText(document, '😀Hello', options).length, 0);
	assert.equal(findDocumentText(document, 'Hel', options).length, 0);
	assert.equal(findDocumentText(document, '[', options).length, 0);
	const selection = textSelection({ nodeId: 'a', offset: 1 });
	using model = DocumentTextModel.create(schema, document, { selection });
	const version = model.version;
	model.dispatch(createReplaceDocumentMatchesCommand(schema, model.document, matches, 'World')!.transaction);
	assert.equal(model.version, version + 1);
	assert.equal(findDocumentText(model.document, 'World', options).length, 5);
	assert.equal(model.document.content[0]!.attrs.indentStart, 18);
	assert.equal(model.document.content[0]!.content.some(node => node.type === 'image'), true);
	assert.equal(model.document.content[1]!.content.length, 1, 'code content stays in the parent model');
	model.undoBlocks();
	assert.deepEqual(model.document, document);
	assert.deepEqual(model.selection, selection);
	model.redoBlocks();
	assert.equal(findDocumentText(model.document, 'World', options).length, 5);
});


test('Academy named styles produce self-contained clipboard fragments and allow toolbar block conversion', () => {
	const schema = createDefaultDocumentSchema();
	using source = DocumentTextModel.create(schema, schema.createDocument(['one', 'two'].map((text, i) => schema.createNode('paragraph', { id: `p${i}`, attrs: { indentStart: 36 }, content: [schema.createText(text, { id: `t${i}` })] }))));
	source.dispatch(createDefineParagraphStyleCommand(source.document, 'p0', 'Essay')!.transaction);
	const fragment = deserializeDocumentFragment(serializeDocumentFragment(extractDocumentFragment(schema, source.document, allSelection())!, schema), schema);
	assert.equal(fragment.content[0]!.attrs.styleId, undefined);
	assert.equal(fragment.content[0]!.attrs.indentStart, 36);
	using destination = DocumentTextModel.create(schema, schema.createDocument([schema.createNode('paragraph', { id: 'target', content: [schema.createText('target', { id: 'target-text' })] })]));
	destination.dispatch(createInsertFragmentCommand(schema, destination.document, 'target', allSelection(), fragment)!.transaction);
	assert.equal(destination.document.content.length, 2);
	assert.deepEqual(deserializeDocument(serializeDocument(destination.document, schema), schema), destination.document);
	source.dispatch(createSetBlockTypeCommand(source.document, 'p0', 'heading')!.transaction);
	assert.equal(source.document.content[0]!.type, 'heading');
	assert.equal(source.document.content[0]!.attrs.styleId, undefined);
	source.undoBlocks();
	assert.equal(source.document.content[0]!.type, 'paragraph');
	assert.equal(getDocumentParagraphStyles(source.document).length, 1);
});


test('Academy replacing entire marked runs with empty text leaves valid empty blocks and restores UTF-16 selections', () => {
	const schema = createDefaultDocumentSchema();
	const document = schema.createDocument([
		schema.createNode('paragraph', { id: 'p', content: [schema.createText('😀', { id: 'a', marks: [{ type: 'strong', attrs: {} }] }), schema.createText('文', { id: 'b' })] }),
		schema.createNode('codeBlock', { id: 'code', content: [schema.createText('😀文', { id: 'c' })] }),
	]);
	const selection = textSelection({ nodeId: 'a', offset: 0 }, { nodeId: 'b', offset: 1 });
	using model = DocumentTextModel.create(schema, document, { selection });
	const matches = findDocumentText(document, '😀文', { matchCase: false, wholeWord: false });
	assert.equal(matches.length, 2);
	model.dispatch(createReplaceDocumentMatchesCommand(schema, document, matches, '')!.transaction);
	assert.deepEqual(model.document.content.map(node => node.content), [[], []]);
	model.undoBlocks();
	assert.deepEqual(model.document, document);
	assert.deepEqual(model.selection, selection);
});
