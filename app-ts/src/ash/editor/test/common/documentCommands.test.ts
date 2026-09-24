import assert from 'node:assert/strict';
import { test } from 'mocha';
import { createDefaultDocumentSchema } from '../../common/model/documentSchema.js';
import { TextModel } from '../../common/model/textModel.js';
import { deserializeDocument, serializeDocument } from '../../common/model/documentSerialization.js';
import { nodeSelection, textSelection } from '../../common/core/documentSelection.js';
import { createDeleteAdjacentInlineNodeCommand, createDeleteInlineSelectionCommand, createDeleteNodeSelectionCommand, createDeleteTableColumnCommand, createDeleteTableRowCommand, createExitEmptyListItemCommand, createInsertHardBreakCommand, createInsertHorizontalRuleCommand, createInsertImageAtSelectionCommand, createInsertImageCommand, createInsertParagraphAfterCommand, createInsertTableColumnCommand, createInsertTableCommand, createInsertTableRowCommand, createJoinAdjacentBlockCommand, createJoinAdjacentListItemCommand, createJoinAdjacentTextRunCommand, createListItemIndentationCommand, createMoveBlockCommand, createPasteTextCommand, createRemoveMarkCommand, createReplaceTextCommand, createSetBlockTypeCommand, createSetLinkMarkCommand, createSetTextStyleCommand, createSplitBlockCommand, createSplitListItemCommand, createToggleBlockquoteCommand, createToggleListCommand, createToggleMarkCommand, findAdjacentTableCell, findTableCellContext } from '../../common/commands/documentCommands.js';

test("Stanza block commands split, join, move, and insert through model transactions", () => {
	const schema = createDefaultDocumentSchema();
	const first = schema.createNode("paragraph", {
		id: "paragraph-1",
		content: [schema.createText("Hello", { id: "text-1" })],
	});
	const second = schema.createNode("paragraph", {
		id: "paragraph-2",
		content: [schema.createText("World", { id: "text-2" })],
	});
	using model = TextModel.create(schema, schema.createDocument([first, second], "document-1"));

	const split = createSplitBlockCommand(schema, model.document, "paragraph-1", "text-1", 2);
	assert.ok(split);
	model.dispatch(split.transaction);
	assert.deepEqual(model.document.content.map(node => node.content[0]?.text ?? ""), ["He", "llo", "World"]);

	const joined = createJoinAdjacentBlockCommand(model.document, "paragraph-2", "text-2", "backward");
	assert.ok(joined);
	model.dispatch(joined.transaction);
	assert.equal(model.document.content.find(node => node.id === "paragraph-2"), undefined);
	assert.equal(model.document.content[1]?.content[0]?.text, "lloWorld");

	const inserted = createInsertParagraphAfterCommand(schema, model.document, "paragraph-1");
	assert.ok(inserted);
	model.dispatch(inserted.transaction);
	assert.equal(model.document.content.length, 3);

	const moved = createMoveBlockCommand(model.document, inserted.focus.blockId, "up");
	assert.ok(moved);
	model.dispatch(moved.transaction);
	assert.equal(model.document.content[0]?.id, inserted.focus.blockId);
	assert.equal(model.canUndoBlocks, true);
});

test("Stanza moves a block down to the requested sibling index", () => {
	const schema = createDefaultDocumentSchema();
	const blocks = ["one", "two", "three"].map((text, index) => schema.createNode("paragraph", {
		id: `paragraph-${index + 1}`,
		content: [schema.createText(text, { id: `text-${index + 1}` })],
	}));
	using model = TextModel.create(schema, schema.createDocument(blocks, "document-1"));

	const move = createMoveBlockCommand(model.document, "paragraph-1", "down");
	assert.ok(move);
	model.dispatch(move.transaction);

	assert.deepEqual(model.document.content.map(node => node.id), ["paragraph-2", "paragraph-1", "paragraph-3"]);
	model.undoBlocks();
	assert.deepEqual(model.document.content.map(node => node.id), ["paragraph-1", "paragraph-2", "paragraph-3"]);
});

test("Stanza inline mark commands split text runs and preserve the selection", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", {
		id: "paragraph-1",
		content: [schema.createText("Hello", { id: "text-1" })],
	});
	using model = TextModel.create(schema, schema.createDocument([paragraph], "document-1"));
	const selection = textSelection({ nodeId: "text-1", offset: 1 }, { nodeId: "text-1", offset: 4 });

	const mark = createToggleMarkCommand(schema, model.document, "paragraph-1", "text-1", selection, "strong");
	assert.ok(mark);
	model.dispatch(mark.transaction);
	const textRuns = model.document.content[0]?.content ?? [];
	assert.deepEqual(textRuns.map(node => node.text), ["H", "ell", "o"]);
	assert.deepEqual(textRuns[1]?.marks, [{ type: "strong", attrs: {} }]);
	assert.deepEqual(model.selection, textSelection({ nodeId: textRuns[1]!.id, offset: 0 }, { nodeId: textRuns[1]!.id, offset: 3 }));

	model.undoBlocks();
	assert.deepEqual(model.document.content[0]?.content.map(node => node.text), ["Hello"]);
	model.redoBlocks();
	const markedText = model.document.content[0]?.content[1];
	assert.ok(markedText);
	const unmark = createToggleMarkCommand(schema, model.document, "paragraph-1", markedText.id, textSelection({ nodeId: markedText.id, offset: 0 }, { nodeId: markedText.id, offset: markedText.text!.length }), "strong");
	assert.ok(unmark);
	model.dispatch(unmark.transaction);
	assert.equal(model.document.content[0]?.content[1]?.marks.length, 0);
});

test("Stanza stores collapsed mark toggles for subsequent text insertion", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("Hello", { id: "text-1" })] });
	using model = TextModel.create(schema, schema.createDocument([paragraph], "document-1"), { selection: textSelection({ nodeId: "text-1", offset: 5 }) });

	const toggle = createToggleMarkCommand(schema, model.document, "paragraph-1", "text-1", model.selection!, "strong");
	assert.ok(toggle);
	assert.deepEqual(toggle.transaction.storedMarks, [{ type: "strong", attrs: {} }]);
	assert.equal(toggle.transaction.steps.length, 0);
	model.dispatch(toggle.transaction);
	assert.deepEqual(model.storedMarks, [{ type: "strong", attrs: {} }]);

	const insert = createReplaceTextCommand(schema, model.document, "paragraph-1", model.selection!, "!", model.storedMarks);
	assert.ok(insert);
	model.dispatch(insert.transaction);
	assert.equal(model.document.content[0]?.content[0]?.text, "Hello!");
	assert.deepEqual(model.document.content[0]?.content[0]?.marks, [{ type: "strong", attrs: {} }]);

	const off = createToggleMarkCommand(schema, model.document, "paragraph-1", "text-1", model.selection!, "strong", {}, model.storedMarks);
	assert.ok(off);
	model.dispatch(off.transaction);
	assert.deepEqual(model.storedMarks, []);
});

test("Stanza link mark commands set, update, remove, and undo link attributes", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", {
		id: "paragraph-1",
		content: [
			schema.createText("Hello", { id: "text-1" }),
			schema.createText(" world", { id: "text-2", marks: [{ type: "strong", attrs: {} }] }),
		],
	});
	using model = TextModel.create(schema, schema.createDocument([paragraph], "document-1"));
	const selection = textSelection({ nodeId: "text-1", offset: 1 }, { nodeId: "text-2", offset: 6 });

	const link = createSetLinkMarkCommand(schema, model.document, "paragraph-1", "text-1", selection, " https://example.test ");
	assert.ok(link);
	model.dispatch(link.transaction);
	let content = model.document.content[0]?.content ?? [];
	assert.deepEqual(content.map(node => node.text), ["H", "ello", " world"]);
	assert.deepEqual(content[1]?.marks, [{ type: "link", attrs: { href: "https://example.test" } }]);
	assert.deepEqual(content[2]?.marks, [{ type: "strong", attrs: {} }, { type: "link", attrs: { href: "https://example.test" } }]);

	const updatedSelection = model.selection;
	assert.equal(updatedSelection?.kind, "text");
	if (updatedSelection?.kind !== "text") return;
	const update = createSetLinkMarkCommand(schema, model.document, "paragraph-1", updatedSelection.anchor.nodeId, updatedSelection, "https://updated.test");
	assert.ok(update);
	model.dispatch(update.transaction);
	content = model.document.content[0]?.content ?? [];
	assert.equal(content[1]?.marks.find(mark => mark.type === "link")?.attrs.href, "https://updated.test");
	assert.equal(content[2]?.marks.find(mark => mark.type === "link")?.attrs.href, "https://updated.test");

	const removalSelection = model.selection;
	assert.equal(removalSelection?.kind, "text");
	if (removalSelection?.kind !== "text") return;
	const remove = createRemoveMarkCommand(schema, model.document, "paragraph-1", removalSelection.anchor.nodeId, removalSelection, "link");
	assert.ok(remove);
	model.dispatch(remove.transaction);
	content = model.document.content[0]?.content ?? [];
	assert.deepEqual(content.map(node => node.marks.map(mark => mark.type)), [[], [], ["strong"]]);
	model.undoBlocks();
	assert.equal(model.document.content[0]?.content[1]?.marks.find(mark => mark.type === "link")?.attrs.href, "https://updated.test");
});

test("Stanza text-style commands merge persistent font attributes", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", {
		id: "paragraph-1",
		content: [schema.createText("Hello", { id: "text-1" })],
	});
	using model = TextModel.create(schema, schema.createDocument([paragraph], "document-1"));
	const selection = textSelection({ nodeId: "text-1", offset: 1 }, { nodeId: "text-1", offset: 4 });

	const setFamily = createSetTextStyleCommand(schema, model.document, "paragraph-1", "text-1", selection, { fontFamily: "serif" });
	assert.ok(setFamily);
	model.dispatch(setFamily.transaction);
	let styled = model.document.content[0]?.content[1];
	assert.ok(styled);
	assert.deepEqual(styled.marks, [{ type: "textStyle", attrs: { fontFamily: "serif" } }]);

	const styledSelection = model.selection;
	assert.equal(styledSelection?.kind, "text");
	if (styledSelection?.kind !== "text") return;
	const setSize = createSetTextStyleCommand(schema, model.document, "paragraph-1", styledSelection.anchor.nodeId, styledSelection, { fontSize: 18 });
	assert.ok(setSize);
	model.dispatch(setSize.transaction);
	styled = model.document.content[0]?.content[1];
	assert.ok(styled);
	assert.deepEqual(styled.marks, [{ type: "textStyle", attrs: { fontFamily: "serif", fontSize: 18 } }]);

	const serialized = serializeDocument(model.document, schema);
	assert.deepEqual(deserializeDocument(serialized, schema).content[0]?.content[1]?.marks, [{ type: "textStyle", attrs: { fontFamily: "serif", fontSize: 18 } }]);
	assert.throws(() => schema.createText("Invalid", { marks: [{ type: "textStyle", attrs: {} }] }), /Text style marks require/);
});

test("Stanza block commands preserve inline runs while splitting and joining", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", {
		id: "paragraph-1",
		content: [
			schema.createText("H", { id: "text-1", marks: [{ type: "strong", attrs: {} }] }),
			schema.createText("ell", { id: "text-2", marks: [{ type: "strong", attrs: {} }] }),
			schema.createText("o", { id: "text-3" }),
		],
	});
	using model = TextModel.create(schema, schema.createDocument([paragraph], "document-1"));

	const split = createSplitBlockCommand(schema, model.document, "paragraph-1", "text-2", 1);
	assert.ok(split);
	model.dispatch(split.transaction);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.text), ["H", "e"]);
	assert.deepEqual(model.document.content[1]?.content.map(node => node.text), ["ll", "o"]);
	assert.equal(model.document.content[1]?.content[0]?.marks[0]?.type, "strong");

	const joined = createJoinAdjacentBlockCommand(model.document, model.document.content[1]!.id, model.document.content[1]!.content[0]!.id, "backward");
	assert.ok(joined);
	model.dispatch(joined.transaction);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.text), ["H", "ell", "o"]);

	const inlineJoin = createJoinAdjacentTextRunCommand(model.document, "paragraph-1", "text-2", "backward");
	assert.ok(inlineJoin);
	model.dispatch(inlineJoin.transaction);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.text), ["Hell", "o"]);
	assert.equal(model.document.content[0]?.content[0]?.marks[0]?.type, "strong");
});

test("Stanza structural block commands toggle blockquotes and insert horizontal rules", () => {
	const schema = createDefaultDocumentSchema();
	const first = schema.createNode("paragraph", {
		id: "paragraph-1",
		content: [schema.createText("First", { id: "text-1" })],
	});
	const second = schema.createNode("paragraph", {
		id: "paragraph-2",
		content: [schema.createText("Second", { id: "text-2" })],
	});
	using model = TextModel.create(schema, schema.createDocument([first, second], "document-1"));

	const quote = createToggleBlockquoteCommand(schema, model.document, "paragraph-1");
	assert.ok(quote);
	model.dispatch(quote.transaction);
	assert.deepEqual(model.document.content.map(node => node.type), ["blockquote", "paragraph"]);
	assert.equal(model.document.content[0]?.content[0]?.id, "paragraph-1");
	assert.equal(quote.focus.blockId, "paragraph-1");

	const unquote = createToggleBlockquoteCommand(schema, model.document, "paragraph-1");
	assert.ok(unquote);
	model.dispatch(unquote.transaction);
	assert.deepEqual(model.document.content.map(node => node.type), ["paragraph", "paragraph"]);

	const rule = createInsertHorizontalRuleCommand(schema, model.document, "paragraph-1");
	assert.ok(rule);
	model.dispatch(rule.transaction);
	assert.deepEqual(model.document.content.map(node => node.type), ["paragraph", "horizontalRule", "paragraph"]);
	model.undoBlocks();
	assert.deepEqual(model.document.content.map(node => node.type), ["paragraph", "paragraph"]);
});

test("Stanza replaces and undoes a text selection spanning sibling blocks", () => {
	const schema = createDefaultDocumentSchema();
	const blocks = ["First", "Middle", "Third"].map((text, index) => schema.createNode("paragraph", {
		id: `paragraph-${index + 1}`,
		content: [schema.createText(text, { id: `text-${index + 1}` })],
	}));
	using model = TextModel.create(schema, schema.createDocument(blocks, "document-1"));
	const selection = textSelection({ nodeId: "text-1", offset: 2 }, { nodeId: "text-3", offset: 2 });

	const replace = createReplaceTextCommand(schema, model.document, "paragraph-1", selection, "X");
	assert.ok(replace);
	model.dispatch(replace.transaction);
	assert.deepEqual(model.document.content.map(node => node.id), ["paragraph-1"]);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.text), ["Fi", "X", "ird"]);
	assert.equal(model.selection?.kind, "text");
	assert.equal(model.selection?.kind === "text" ? model.selection.anchor.nodeId : undefined, model.document.content[0]?.content[1]?.id);

	model.undoBlocks();
	assert.deepEqual(model.document.content.map(node => node.id), ["paragraph-1", "paragraph-2", "paragraph-3"]);
	assert.deepEqual(model.document.content.map(node => node.content[0]?.text), ["First", "Middle", "Third"]);
});

test("Stanza pastes multiline text across sibling blocks", () => {
	const schema = createDefaultDocumentSchema();
	const blocks = ["First", "Middle", "Third"].map((text, index) => schema.createNode("paragraph", {
		id: `paragraph-${index + 1}`,
		content: [schema.createText(text, { id: `text-${index + 1}` })],
	}));
	using model = TextModel.create(schema, schema.createDocument(blocks, "document-1"));
	const selection = textSelection({ nodeId: "text-1", offset: 2 }, { nodeId: "text-2", offset: 3 });

	const paste = createPasteTextCommand(schema, model.document, "paragraph-1", selection, "A\nB\nC");
	assert.ok(paste);
	model.dispatch(paste.transaction);
	assert.deepEqual(model.document.content.map(node => node.content.filter(child => child.text !== undefined).map(child => child.text).join("")), ["FiA", "B", "Cdle", "Third"]);
	assert.equal(model.selection?.kind, "text");
	assert.equal(model.selection?.kind === "text" ? model.selection.anchor.nodeId : undefined, model.document.content[2]?.content.at(-1)?.id);
});

test("Stanza inline commands handle selections spanning multiple text runs", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", {
		id: "paragraph-1",
		content: [
			schema.createText("H", { id: "text-1" }),
			schema.createText("ell", { id: "text-2", marks: [{ type: "strong", attrs: {} }] }),
			schema.createText("o", { id: "text-3" }),
		],
	});
	using model = TextModel.create(schema, schema.createDocument([paragraph], "document-1"));
	const wholeText = textSelection({ nodeId: "text-1", offset: 0 }, { nodeId: "text-3", offset: 1 });

	const mark = createToggleMarkCommand(schema, model.document, "paragraph-1", "text-1", wholeText, "strong");
	assert.ok(mark);
	model.dispatch(mark.transaction);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.marks.map(mark => mark.type)), [["strong"], ["strong"], ["strong"]]);
	assert.deepEqual(model.selection, wholeText);

	const unmark = createToggleMarkCommand(schema, model.document, "paragraph-1", "text-1", wholeText, "strong");
	assert.ok(unmark);
	model.dispatch(unmark.transaction);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.marks), [[], [], []]);

	const replace = createReplaceTextCommand(schema, model.document, "paragraph-1", textSelection({ nodeId: "text-1", offset: 1 }, { nodeId: "text-3", offset: 0 }), "X");
	assert.ok(replace);
	model.dispatch(replace.transaction);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.text), ["H", "X", "o"]);
	assert.equal(model.selection?.kind, "text");
});

test("Stanza paste commands turn multiline text into sibling blocks", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", {
		id: "paragraph-1",
		content: [schema.createText("Hello", { id: "text-1" })],
	});
	using model = TextModel.create(schema, schema.createDocument([paragraph], "document-1"));
	const paste = createPasteTextCommand(schema, model.document, "paragraph-1", textSelection({ nodeId: "text-1", offset: 2 }), "A\nB\n");
	assert.ok(paste);
	model.dispatch(paste.transaction);
	assert.deepEqual(model.document.content.map(node => node.content.map(child => child.text ?? "").join("")), ["HeA", "B", "llo"]);
	assert.equal(model.selection?.kind, "text");
	assert.equal(model.canUndoBlocks, true);
	model.undoBlocks();
	assert.deepEqual(model.document.content.map(node => node.content[0]?.text ?? ""), ["Hello"]);
});

test("Stanza splits a list paragraph into sibling list items", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", {
		id: "paragraph-1",
		content: [schema.createText("oneTwo", { id: "text-1" })],
	});
	const item = schema.createNode("listItem", { id: "item-1", content: [paragraph] });
	const list = schema.createNode("bulletList", { id: "list-1", content: [item] });
	using model = TextModel.create(schema, schema.createDocument([list], "document-1"));

	const split = createSplitListItemCommand(schema, model.document, "item-1", "paragraph-1", "text-1", 3);
	assert.ok(split);
	model.dispatch(split.transaction);
	const result = model.document.content[0]!;
	assert.equal(result.type, "bulletList");
	assert.deepEqual(result.content.map(listItem => listItem.content[0]?.content[0]?.text ?? ""), ["one", "Two"]);
	assert.equal(result.content.length, 2);
	model.undoBlocks();
	assert.equal(model.document.content[0]?.content[0]?.content[0]?.content[0]?.text, "oneTwo");
});

test("Stanza joins, indents, and outdents list items as atomic commands", () => {
	const schema = createDefaultDocumentSchema();
	const createItem = (id: string, paragraphId: string, textId: string, text: string) => schema.createNode("listItem", { id, content: [schema.createNode("paragraph", { id: paragraphId, content: [schema.createText(text, { id: textId })] })] });
	const list = schema.createNode("bulletList", { id: "list-1", content: [createItem("item-1", "paragraph-1", "text-1", "one"), createItem("item-2", "paragraph-2", "text-2", "two"), createItem("item-3", "paragraph-3", "text-3", "three")] });
	using model = TextModel.create(schema, schema.createDocument([list], "document-1"));

	const joined = createJoinAdjacentListItemCommand(model.document, "item-2", "paragraph-2", "backward");
	assert.ok(joined);
	model.dispatch(joined.transaction);
	assert.equal(model.document.content[0]?.content.length, 2);
	assert.equal(model.document.content[0]?.content[0]?.content.map(block => block.content.map(child => child.text ?? "").join("")).join(""), "onetwo");
	model.undoBlocks();

	const indented = createListItemIndentationCommand(schema, model.document, "item-2", "paragraph-2", "in");
	assert.ok(indented);
	model.dispatch(indented.transaction);
	const indentedList = model.document.content[0]!;
	assert.equal(indentedList.content.length, 2);
	assert.equal(indentedList.content[0]?.content.at(-1)?.type, "bulletList");
	assert.equal(indentedList.content[0]?.content.at(-1)?.content[0]?.id, "item-2");

	const outdented = createListItemIndentationCommand(schema, model.document, "item-2", "paragraph-2", "out");
	assert.ok(outdented);
	model.dispatch(outdented.transaction);
	assert.deepEqual(model.document.content[0]?.content.map(item => item.id), ["item-1", "item-2", "item-3"]);
	assert.equal(model.document.content[0]?.content[0]?.content.some(child => child.type === "bulletList"), false);
	model.undoBlocks();
	assert.equal(model.document.content[0]?.content[0]?.content.at(-1)?.content[0]?.id, "item-2");
	model.undoBlocks();
	assert.deepEqual(model.document.content[0]?.content.map(item => item.id), ["item-1", "item-2", "item-3"]);
});

test("Stanza exits an empty list item at the list boundary", () => {
	const schema = createDefaultDocumentSchema();
	const emptyItem = schema.createNode("listItem", { id: "item-1", content: [schema.createNode("paragraph", { id: "paragraph-1" })] });
	const list = schema.createNode("bulletList", { id: "list-1", content: [emptyItem] });
	using model = TextModel.create(schema, schema.createDocument([list], "document-1"));
	const exit = createExitEmptyListItemCommand(schema, model.document, "item-1", "paragraph-1");
	assert.ok(exit);
	model.dispatch(exit.transaction);
	assert.deepEqual(model.document.content.map(node => node.type), ["paragraph"]);
	assert.equal(model.document.content[0]?.content.length, 0);
	model.undoBlocks();
	assert.equal(model.document.content[0]?.type, "bulletList");
});

test("Stanza block format commands change block and list types without replacing content", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("Hello", { id: "text-1" })] });
	using model = TextModel.create(schema, schema.createDocument([paragraph], "document-1"));

	const heading = createSetBlockTypeCommand(model.document, "paragraph-1", "heading");
	assert.ok(heading);
	model.dispatch(heading.transaction);
	assert.equal(model.document.content[0]?.type, "heading");
	assert.equal(model.document.content[0]?.content[0]?.text, "Hello");

	const bullet = createToggleListCommand(schema, model.document, "paragraph-1", "bulletList");
	assert.ok(bullet);
	model.dispatch(bullet.transaction);
	assert.equal(model.document.content[0]?.type, "bulletList");
	assert.equal(model.document.content[0]?.content[0]?.content[0]?.type, "heading");

	const ordered = createToggleListCommand(schema, model.document, "paragraph-1", "orderedList");
	assert.ok(ordered);
	model.dispatch(ordered.transaction);
	assert.equal(model.document.content[0]?.type, "orderedList");
	model.undoBlocks();
	assert.equal(model.document.content[0]?.type, "bulletList");
	model.undoBlocks();
	assert.equal(model.document.content[0]?.type, "heading");
});

test("Stanza inserts validated tables and inline images", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("Hello", { id: "text-1" })] });
	using model = TextModel.create(schema, schema.createDocument([paragraph], "document-1"));

	const table = createInsertTableCommand(schema, model.document, "paragraph-1", 2, 3);
	assert.ok(table);
	model.dispatch(table.transaction);
	const tableNode = model.document.content[1];
	assert.equal(tableNode?.type, "table");
	assert.equal(tableNode?.content.length, 2);
	assert.equal(tableNode?.content[0]?.content.length, 3);
	assert.equal(tableNode?.content[0]?.content[0]?.content[0]?.type, "paragraph");

	const image = createInsertImageCommand(schema, model.document, "paragraph-1", "https://example.test/image.png", "Example");
	assert.ok(image);
	model.dispatch(image.transaction);
	assert.deepEqual(model.document.content[0]?.content.at(-1)?.attrs, { src: "https://example.test/image.png", alt: "Example" });
	model.undoBlocks();
	assert.equal(model.document.content[0]?.content.at(-1)?.type, "text");
});

test("Stanza inserts images at text selections while preserving inline runs", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", {
		id: "paragraph-1",
		content: [
			schema.createText("Hello", { id: "text-1" }),
			schema.createText(" world", { id: "text-2", marks: [{ type: "strong", attrs: {} }] }),
		],
	});
	using model = TextModel.create(schema, schema.createDocument([paragraph], "document-1"));

	const middle = createInsertImageAtSelectionCommand(schema, model.document, "paragraph-1", textSelection({ nodeId: "text-1", offset: 2 }), "data:image/png;base64,AA==", "middle");
	assert.ok(middle);
	model.dispatch(middle.transaction);
	let content = model.document.content[0]!.content;
	assert.deepEqual(content.map(node => node.type), ["text", "image", "text", "text"]);
	assert.deepEqual(content.filter(node => node.text !== undefined).map(node => node.text), ["He", "llo", " world"]);
	assert.deepEqual(content.filter(node => node.text !== undefined).map(node => node.marks.map(mark => mark.type)), [[], [], ["strong"]]);
	assert.equal(model.selection?.kind, "text");
	assert.equal(model.selection?.kind === "text" ? model.selection.anchor.offset : undefined, 0);
	model.undoBlocks();
	assert.deepEqual(model.document.content[0]?.content.map(node => node.id), ["text-1", "text-2"]);

	const crossRun = createInsertImageAtSelectionCommand(schema, model.document, "paragraph-1", textSelection({ nodeId: "text-1", offset: 3 }, { nodeId: "text-2", offset: 3 }), "data:image/png;base64,BB==");
	assert.ok(crossRun);
	model.dispatch(crossRun.transaction);
	content = model.document.content[0]!.content;
	assert.deepEqual(content.map(node => node.type), ["text", "image", "text"]);
	assert.deepEqual(content.filter(node => node.text !== undefined).map(node => node.text), ["Hel", "rld"]);
	assert.deepEqual(content.filter(node => node.text !== undefined).map(node => node.marks.map(mark => mark.type)), [[], ["strong"]]);
});

test("Stanza deletes adjacent inline nodes through common boundary commands", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", {
		id: "paragraph-1",
		content: [
			schema.createText("before", { id: "text-1" }),
			schema.createNode("image", { id: "image-1", attrs: { src: "data:image/png;base64,AA==" } }),
			schema.createText("after", { id: "text-2" }),
		],
	});
	using model = TextModel.create(schema, schema.createDocument([paragraph], "document-1"));

	const backward = createDeleteAdjacentInlineNodeCommand(model.document, "paragraph-1", "text-2", "backward");
	assert.ok(backward);
	model.dispatch(backward.transaction);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.id), ["text-1", "text-2"]);
	model.undoBlocks();

	const forward = createDeleteAdjacentInlineNodeCommand(model.document, "paragraph-1", "text-1", "forward");
	assert.ok(forward);
	model.dispatch(forward.transaction);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.id), ["text-1", "text-2"]);
	model.undoBlocks();
	assert.equal(model.document.content[0]?.content[1]?.type, "image");
});

test("Stanza deletes and restores a selected inline node", () => {
	const schema = createDefaultDocumentSchema();
	const image = schema.createNode("image", { id: "image-1", attrs: { src: "data:image/png;base64,AA==" } });
	const paragraph = schema.createNode("paragraph", {
		id: "paragraph-1",
		content: [schema.createText("before", { id: "text-1" }), image, schema.createText("after", { id: "text-2" })],
	});
	using model = TextModel.create(schema, schema.createDocument([paragraph], "document-1"), { selection: nodeSelection(image.id) });

	const deletion = createDeleteNodeSelectionCommand(model.document, model.selection!);
	assert.ok(deletion);
	model.dispatch(deletion.transaction);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.type), ["text", "text"]);
	assert.equal(model.selection?.kind, "text");
	model.undoBlocks();
	assert.equal(model.document.content[0]?.content[1]?.id, image.id);
	assert.deepEqual(model.selection, nodeSelection(image.id));
	model.redoBlocks();
	assert.equal(model.document.content[0]?.content.some(node => node.id === image.id), false);
});

test("Stanza inserts hard breaks and deletes selections spanning inline nodes", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", {
		id: "paragraph-1",
		content: [
			schema.createText("Hello", { id: "text-1" }),
			schema.createNode("hardBreak", { id: "break-1" }),
			schema.createText("world", { id: "text-2" }),
		],
	});
	using model = TextModel.create(schema, schema.createDocument([paragraph], "document-1"));

	const breakCommand = createInsertHardBreakCommand(schema, model.document, "paragraph-1", textSelection({ nodeId: "text-1", offset: 2 }));
	assert.ok(breakCommand);
	model.dispatch(breakCommand.transaction);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.type), ["text", "hardBreak", "text", "hardBreak", "text"]);
	assert.equal(model.document.content[0]?.content[0]?.text, "He");
	assert.equal(model.document.content[0]?.content[2]?.text, "llo");
	model.undoBlocks();

	const deletion = createDeleteInlineSelectionCommand(schema, model.document, "paragraph-1", textSelection({ nodeId: "text-1", offset: 2 }, { nodeId: "text-2", offset: 3 }));
	assert.ok(deletion);
	model.dispatch(deletion.transaction);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.type), ["text", "text"]);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.text), ["He", "ld"]);
	assert.equal(model.selection?.kind, "text");
});

test("Stanza navigates table cells and applies row and column transactions", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("Before", { id: "text-1" })] });
	using model = TextModel.create(schema, schema.createDocument([paragraph], "document-1"));
	const insertTable = createInsertTableCommand(schema, model.document, "paragraph-1", 2, 2);
	assert.ok(insertTable);
	model.dispatch(insertTable.transaction);

	let table = model.document.content[1]!;
	const firstRow = table.content[0]!;
	const secondCell = firstRow.content[1]!;
	assert.equal(findAdjacentTableCell(model.document, firstRow.content[0]!.id, "forward"), secondCell.id);
	assert.equal(findAdjacentTableCell(model.document, firstRow.content[0]!.id, "backward"), undefined);
	assert.equal(findTableCellContext(model.document, firstRow.content[0]!.content[0]!.id)?.columnIndex, 0);

	const insertedRow = createInsertTableRowCommand(schema, model.document, table.id, 1);
	assert.ok(insertedRow);
	model.dispatch(insertedRow.transaction);
	table = model.document.content[1]!;
	assert.equal(table.content.length, 3);
	assert.equal(table.content[1]?.content.length, 2);

	const insertedColumn = createInsertTableColumnCommand(schema, model.document, table.id, 1);
	assert.ok(insertedColumn);
	model.dispatch(insertedColumn.transaction);
	table = model.document.content[1]!;
	assert.deepEqual(table.content.map(row => row.content.length), [3, 3, 3]);

	const deletedColumn = createDeleteTableColumnCommand(model.document, table.id, 1);
	assert.ok(deletedColumn);
	model.dispatch(deletedColumn.transaction);
	table = model.document.content[1]!;
	assert.deepEqual(table.content.map(row => row.content.length), [2, 2, 2]);

	const deletedRow = createDeleteTableRowCommand(model.document, table.id, table.content[1]!.id);
	assert.ok(deletedRow);
	model.dispatch(deletedRow.transaction);
	assert.equal(model.document.content[1]?.content.length, 2);
	model.undoBlocks();
	assert.equal(model.document.content[1]?.content.length, 3);
});
