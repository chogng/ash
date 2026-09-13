import assert from "node:assert/strict";
import { test } from "mocha";
import { URI } from "../../../base/common/uri.js";
import { createDefaultDocumentSchema, DocumentSchema } from "../../common/model/documentSchema.js";
import { createInsertCitationCommand, createInsertReferenceCommand } from "../../contrib/citation/common/citationCommands.js";
import { buildReferenceIndex, createReferenceIndexPlugin, REFERENCE_INDEX_KEY } from "../../contrib/citation/common/references.js";
import { createAcademicDocumentSchema, createEmptyAcademicDocument } from "../../contrib/academic/common/schema.js";
import { TextModel } from "../../common/model/textModel.js";
import { createDocumentDecoration, DocumentDecorationSet } from "../../common/model/documentDecoration.js";
import { buildDocumentOutline } from "../../common/model/documentOutline.js";
import { documentContentSize, documentNodeSize, documentPointToPosition, documentPositionToPoint, resolveDocumentPosition } from "../../common/core/documentPosition.js";
import { documentSelectionToText } from "../../common/model/documentText.js";
import { extractDocumentFragment } from "../../common/model/documentFragment.js";
import { createDocumentPlugin, DocumentPluginKey } from "../../common/model/documentPlugin.js";
import { deserializeDocument, deserializeDocumentFragment, DocumentSerializationError, serializeDocument, serializeDocumentFragment } from "../../common/model/documentSerialization.js";
import { allSelection, nodeSelection, textSelection } from "../../common/core/documentSelection.js";
import { DocumentTransaction } from "../../common/model/documentTransaction.js";
import { deserializeDocumentTransaction, serializeDocumentTransaction } from "../../common/model/documentTransactionSerialization.js";
import { createDeleteAdjacentInlineNodeCommand, createDeleteInlineSelectionCommand, createDeleteNodeSelectionCommand, createDeleteTableColumnCommand, createDeleteTableRowCommand, createExitEmptyListItemCommand, createInsertFragmentCommand, createInsertHardBreakCommand, createInsertHorizontalRuleCommand, createInsertImageAtSelectionCommand, createInsertImageCommand, createInsertParagraphAfterCommand, createInsertTableColumnCommand, createInsertTableCommand, createInsertTableRowCommand, createJoinAdjacentBlockCommand, createJoinAdjacentListItemCommand, createJoinAdjacentTextRunCommand, createListItemIndentationCommand, createMoveBlockCommand, createPasteTextCommand, createRemoveMarkCommand, createReplaceTextCommand, createSetBlockTypeCommand, createSetLinkMarkCommand, createSetTextStyleCommand, createSplitBlockCommand, createSplitListItemCommand, createToggleBlockquoteCommand, createToggleListCommand, createToggleMarkCommand, findAdjacentTableCell, findTableCellContext } from "../../common/commands/documentCommands.js";

function createDocument(schema: DocumentSchema) {
	const paragraph = schema.createNode("paragraph", {
		id: "paragraph-1",
		content: [schema.createText("Hello", { id: "text-1" })],
	});
	const codeBlock = schema.createNode("codeBlock", {
		id: "code-1",
		attrs: { language: "typescript" },
		content: [schema.createText("const value = 1;", { id: "code-text-1" })],
	});
	return schema.createDocument([paragraph, codeBlock], "document-1");
}

test("DocumentSchema creates and validates block, inline, and code-block nodes", () => {
	const schema = createDefaultDocumentSchema();
	const document = createDocument(schema);

	assert.deepEqual(document.content.map(node => node.type), ["paragraph", "codeBlock"]);
	assert.equal(document.content[1]?.attrs.language, "typescript");
	schema.validate(document);
	assert.throws(() => schema.createNode("heading", { attrs: { level: 7 } }), /between 1 and 6/);
	assert.throws(() => schema.createNode("paragraph", { content: [schema.createNode("codeBlock")] }), /cannot contain/);
	assert.throws(() => schema.createNode("codeBlock", { content: [schema.createText("one"), schema.createText("two")] }), /content does not match/);
});

test("TextModel updates plugin state across edits, history, and reset", () => {
	const schema = createDefaultDocumentSchema();
	const key = new DocumentPluginKey<{ readonly origins: readonly string[]; readonly selections: readonly string[]; readonly versions: readonly number[] }>("audit");
	const plugin = createDocumentPlugin(key, {
		init: context => ({ origins: [], selections: [], versions: [context.version] }),
		apply: (value, context) => ({ origins: [...value.origins, context.origin], selections: value.selections, versions: [...value.versions, context.version] }),
		applySelection: (value, context) => ({ origins: value.origins, selections: [...value.selections, context.selection?.kind ?? "none"], versions: value.versions }),
	});
	using model = TextModel.create(schema, createDocument(schema), { plugins: [plugin] });

	assert.deepEqual(model.getPluginState(key), { origins: [], selections: [], versions: [1] });
	model.setSelection(textSelection({ nodeId: "text-1", offset: 5 }));
	assert.deepEqual(model.getPluginState(key), { origins: [], selections: ["text"], versions: [1] });
	const change = model.dispatch(new DocumentTransaction().replaceText("text-1", 5, 5, "!").withSelection(textSelection({ nodeId: "text-1", offset: 6 })));
	assert.ok(change);
	assert.deepEqual(model.getPluginState(key), { origins: ["user"], selections: ["text"], versions: [1, 2] });

	model.undoBlocks();
	assert.deepEqual(model.getPluginState(key), { origins: ["user", "undo"], selections: ["text"], versions: [1, 2, 3] });
	model.redoBlocks();
	assert.deepEqual(model.getPluginState(key), { origins: ["user", "undo", "redo"], selections: ["text"], versions: [1, 2, 3, 4] });

	const resetDocument = schema.createDocument([schema.createNode("paragraph", { content: [schema.createText("Reset")] })], "reset-document");
	model.resetBlocks(resetDocument);
	assert.deepEqual(model.getPluginState(key), { origins: ["user", "undo", "redo", "reset"], selections: ["text"], versions: [1, 2, 3, 4, 5] });
});

test("TextModel keeps document and plugin state unchanged when a plugin rejects a transaction", () => {
	const schema = createDefaultDocumentSchema();
	const key = new DocumentPluginKey<number>("rejecting");
	const plugin = createDocumentPlugin(key, { init: () => 0, apply: () => { throw new Error("plugin rejected change"); } });
	using model = TextModel.create(schema, createDocument(schema), { plugins: [plugin] });
	const before = model.document;

	assert.throws(() => model.dispatch(new DocumentTransaction().replaceText("text-1", 0, 0, "X")), /plugin rejected change/);
	assert.equal(model.document, before);
	assert.equal(model.version, 1);
	assert.equal(model.canUndoBlocks, false);
	assert.equal(model.getPluginState(key), 0);
});

test("TextModel exposes plugin-owned decoration sources without merging identities", () => {
	const schema = createDefaultDocumentSchema();
	const document = createDocument(schema);
	const key = new DocumentPluginKey<DocumentDecorationSet>("search");
	const plugin = createDocumentPlugin(key, {
		init: context => new DocumentDecorationSet([createDocumentDecoration({ id: "hit", from: { nodeId: context.document.content[0]!.content[0]!.id, offset: 0 }, to: { nodeId: context.document.content[0]!.content[0]!.id, offset: 2 } })]),
		apply: (value, context) => value.map(context.previousDocument, context.schema, context.transaction),
	}, { decorations: (state, context) => {
		assert.equal(context.state, state);
		assert.equal(context.version, 1);
		return state;
	} });
	using model = TextModel.create(schema, document, { plugins: [plugin] });

	const sources = model.getPluginDecorations();
	assert.equal(sources.length, 1);
	assert.equal(sources[0]?.key, key);
	assert.equal(sources[0]?.set.get("hit")?.to.offset, 2);
});

test("DocumentTransaction metadata survives builder methods and history merging", () => {
	const schema = createDefaultDocumentSchema();
	const metaKey = Symbol("inputType");
	const key = new DocumentPluginKey<readonly (string | undefined)[]>("metadata-audit");
	const plugin = createDocumentPlugin(key, {
		init: () => [],
		apply: (value, context) => [...value, context.transaction.getMeta<string>(metaKey)],
	});
	using model = TextModel.create(schema, createDocument(schema), { plugins: [plugin] });
	const first = new DocumentTransaction().replaceText("text-1", 5, 5, "!").withMeta(metaKey, "first").withHistoryGroup("typing");
	const second = new DocumentTransaction().replaceText("text-1", 6, 6, "?").withMeta(metaKey, "second").withHistoryGroup("typing");
	assert.equal(first.withSelection(textSelection({ nodeId: "text-1", offset: 6 })).getMeta<string>(metaKey), "first");
	assert.equal(new DocumentTransaction([], { metadata: [{ key: "duplicate", value: 1 }, { key: "duplicate", value: 2 }] }).getMeta<number>("duplicate"), 2);

	model.dispatch(first);
	model.dispatch(second);
	assert.deepEqual(model.getPluginState(key), ["first", "second"]);
	model.undoBlocks();
	model.redoBlocks();
	assert.deepEqual(model.getPluginState(key), ["first", "second", undefined, "second"]);
});

test("Document plugins can atomically filter user, undo, and redo transactions", () => {
	const schema = createDefaultDocumentSchema();
	const key = new DocumentPluginKey<number>("transaction-filter");
	let blockedOrigin: "user" | "undo" | "redo" | undefined = "user";
	const origins: string[] = [];
	const plugin = createDocumentPlugin(key, { init: () => 0, apply: value => value }, {
		filterTransaction: (_transaction, context) => {
			origins.push(context.origin);
			return context.origin !== blockedOrigin;
		},
	});
	using model = TextModel.create(schema, createDocument(schema), { plugins: [plugin] });
	const before = model.document;

	assert.equal(model.dispatch(new DocumentTransaction().replaceText("text-1", 0, 0, "blocked")), undefined);
	assert.equal(model.document, before);
	blockedOrigin = undefined;
	assert.ok(model.dispatch(new DocumentTransaction().replaceText("text-1", 0, 0, "ok")));
	blockedOrigin = "undo";
	assert.equal(model.undoBlocks(), undefined);
	assert.equal(model.canUndoBlocks, true);
	blockedOrigin = undefined;
	assert.ok(model.undoBlocks());
	assert.equal(model.canRedoBlocks, true);
	blockedOrigin = "redo";
	assert.equal(model.redoBlocks(), undefined);
	assert.equal(model.canRedoBlocks, true);
	blockedOrigin = undefined;
	assert.ok(model.redoBlocks());
	assert.deepEqual(origins, ["user", "user", "undo", "undo", "redo", "redo"]);
});

test("Stanza maps decoration ranges through one transaction and drops ranges with no text", () => {
	const schema = createDefaultDocumentSchema();
	const first = schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("Hello", { id: "text-1" })] });
	const second = schema.createNode("paragraph", { id: "paragraph-2", content: [schema.createText("World", { id: "text-2" })] });
	const document = schema.createDocument([first, second], "document-1");
	const decorations = new DocumentDecorationSet([
		createDocumentDecoration({ id: "hit", from: { nodeId: "text-1", offset: 1 }, to: { nodeId: "text-1", offset: 4 }, className: "search-hit" }),
		createDocumentDecoration({ id: "cross", from: { nodeId: "text-1", offset: 2 }, to: { nodeId: "text-2", offset: 2 }, attrs: { source: "reference" } }),
	]);
	const insert = new DocumentTransaction().replaceText("text-1", 0, 0, "Say ");
	const mapped = decorations.map(document, schema, insert);
	assert.deepEqual(mapped.get("hit")?.from, { nodeId: "text-1", offset: 5 });
	assert.deepEqual(mapped.get("hit")?.to, { nodeId: "text-1", offset: 8 });
	assert.deepEqual(mapped.get("cross")?.from, { nodeId: "text-1", offset: 6 });
	assert.equal(mapped.get("cross")?.attrs.source, "reference");

	const removed = decorations.map(document, schema, new DocumentTransaction().deleteNode("text-1").deleteNode("text-2"));
	assert.equal(removed.size, 0);
	assert.throws(() => decorations.add(createDocumentDecoration({ id: "hit", from: { nodeId: "text-1", offset: 0 } })), /Duplicate document decoration/);
});

test("Stanza converts nested text points to absolute positions with stable boundary bias", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", {
		id: "paragraph-inline",
		content: [
			schema.createText("A", { id: "text-a" }),
			schema.createText("B", { id: "text-b" }),
			schema.createNode("hardBreak", { id: "break-1" }),
			schema.createNode("image", { id: "image-1", attrs: { src: "data:image/png;base64,AA==" } }),
			schema.createText("C", { id: "text-c" }),
		],
	});
	const nestedParagraph = schema.createNode("paragraph", { id: "paragraph-nested", content: [schema.createText("Nested", { id: "text-nested" })] });
	const quote = schema.createNode("blockquote", { id: "quote-1", content: [nestedParagraph] });
	const cellParagraph = schema.createNode("paragraph", { id: "paragraph-cell", content: [schema.createText("Cell", { id: "text-cell" })] });
	const cell = schema.createNode("tableCell", { id: "cell-1", content: [cellParagraph] });
	const row = schema.createNode("tableRow", { id: "row-1", content: [cell] });
	const table = schema.createNode("table", { id: "table-1", content: [row] });
	const document = schema.createDocument([paragraph, quote, table], "document-positions");

	assert.equal(documentNodeSize(schema.createNode("paragraph", { content: [] }), schema), 2);
	assert.equal(documentNodeSize(schema.createNode("horizontalRule"), schema), 1);
	assert.equal(documentContentSize(document, schema), 29);
	assert.equal(documentNodeSize(document, schema), 31);
	assert.equal(documentPointToPosition(document, schema, { nodeId: "text-nested", offset: 3 }), 12);
	assert.equal(documentPointToPosition(document, schema, { nodeId: "text-cell", offset: 4 }), 25);
	assert.deepEqual(documentPositionToPoint(document, schema, 2, "forward"), { nodeId: "text-b", offset: 0 });
	assert.deepEqual(documentPositionToPoint(document, schema, 2, "backward"), { nodeId: "text-a", offset: 1 });
	assert.deepEqual(documentPositionToPoint(document, schema, 7, "forward"), { nodeId: "text-nested", offset: 0 });
	assert.deepEqual(documentPositionToPoint(document, schema, 7, "backward"), { nodeId: "text-c", offset: 1 });

	const resolved = resolveDocumentPosition(document, schema, 12);
	assert.deepEqual(resolved.point, { nodeId: "text-nested", offset: 3 });
	assert.deepEqual(resolved.path.map(entry => ({ type: entry.node.type, start: entry.start, index: entry.index })), [
		{ type: "doc", start: -1, index: -1 },
		{ type: "blockquote", start: 7, index: 1 },
		{ type: "paragraph", start: 8, index: 0 },
		{ type: "text", start: 9, index: 0 },
	]);
	assert.equal(resolved.depth, 3);
	assert.throws(() => documentPointToPosition(document, schema, { nodeId: "image-1", offset: 0 }), /must target a text node/);
	assert.throws(() => documentPositionToPoint(document, schema, 30), /between 0 and 29/);
});

test("TextModel applies text transactions and preserves transaction-level undo", () => {
	const schema = createDefaultDocumentSchema();
	using model = TextModel.create(schema, createDocument(schema));
	model.setSelection(textSelection({ nodeId: "text-1", offset: 5 }));

	const change = model.dispatch(new DocumentTransaction()
		.replaceText("text-1", 5, 5, " structured")
		.withSelection(textSelection({ nodeId: "text-1", offset: 16 })));

	assert.ok(change);
	assert.equal(model.document.content[0]?.content[0]?.text, "Hello structured");
	assert.equal(model.selection?.kind, "text");
	assert.equal(model.canUndoBlocks, true);
	model.undoBlocks();
	assert.equal(model.document.content[0]?.content[0]?.text, "Hello");
	assert.equal(model.selection?.kind, "text");
	model.redoBlocks();
	assert.equal(model.document.content[0]?.content[0]?.text, "Hello structured");
});

test("TextModel maps implicit selections through text edits and node removal", () => {
	const schema = createDefaultDocumentSchema();
	const first = schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("Hello", { id: "text-1" })] });
	const second = schema.createNode("paragraph", { id: "paragraph-2", content: [schema.createText("World", { id: "text-2" })] });
	using model = TextModel.create(schema, schema.createDocument([first, second], "document-1"), { selection: textSelection({ nodeId: "text-1", offset: 5 }) });

	model.dispatch(new DocumentTransaction().replaceText("text-1", 0, 0, "Say "));
	assert.deepEqual(model.selection, textSelection({ nodeId: "text-1", offset: 9 }));

	model.dispatch(new DocumentTransaction().replaceText("text-1", 0, 4, ""));
	assert.deepEqual(model.selection, textSelection({ nodeId: "text-1", offset: 5 }));

	model.dispatch(new DocumentTransaction().deleteNode("text-1"));
	assert.deepEqual(model.selection, textSelection({ nodeId: "text-2", offset: 0 }));
});

test("TextModel coalesces adjacent transactions with the same history group", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("a", { id: "text-1" })] });
	using model = TextModel.create(schema, schema.createDocument([paragraph], "document-1"), { selection: textSelection({ nodeId: "text-1", offset: 1 }) });

	model.dispatch(new DocumentTransaction().replaceText("text-1", 1, 1, "b").withSelection(textSelection({ nodeId: "text-1", offset: 2 })).withHistoryGroup("typing"));
	model.dispatch(new DocumentTransaction().replaceText("text-1", 2, 2, "c").withSelection(textSelection({ nodeId: "text-1", offset: 3 })).withHistoryGroup("typing"));
	assert.equal(model.document.content[0]?.content[0]?.text, "abc");

	const undo = model.undoBlocks();
	assert.ok(undo);
	assert.equal(model.document.content[0]?.content[0]?.text, "a");
	assert.deepEqual(model.selection, textSelection({ nodeId: "text-1", offset: 1 }));
	const redo = model.redoBlocks();
	assert.ok(redo);
	assert.equal(model.document.content[0]?.content[0]?.text, "abc");
	assert.deepEqual(model.selection, textSelection({ nodeId: "text-1", offset: 3 }));

	model.setSelection(textSelection({ nodeId: "text-1", offset: 0 }));
	model.dispatch(new DocumentTransaction().replaceText("text-1", 0, 0, "!").withSelection(textSelection({ nodeId: "text-1", offset: 1 })).withHistoryGroup("typing"));
	model.undoBlocks();
	assert.equal(model.document.content[0]?.content[0]?.text, "abc");
});

test("DocumentSchema supports a custom top node type", () => {
	const schema = new DocumentSchema({
		topNodeType: "article",
		nodes: {
			article: { kind: "root", allowedChildren: ["paragraph"] },
			paragraph: { kind: "block", allowedChildren: ["text"] },
			text: { kind: "text" },
		},
	});
	const paragraph = schema.createNode("paragraph", { content: [schema.createText("Custom root")] });
	const document = schema.createDocument([paragraph]);

	assert.equal(document.type, "article");
	schema.validate(document);
});

test("DocumentSchema supports child groups, cardinality, and valid multi-step assembly", () => {
	const schema = new DocumentSchema({
		topNodeType: "article",
		nodes: {
			article: { kind: "root", allowedChildGroups: ["section"] },
			section: { kind: "block", groups: ["section"], allowedChildren: ["text"], minChildren: 1, maxChildren: 2 },
			text: { kind: "text" },
		},
	});
	const incomplete = schema.createNode("section");
	assert.equal(schema.isLeafNode(incomplete), false);
	assert.equal(schema.isLeafNode(schema.createText("leaf")), true);
	assert.equal(schema.canContainChild("article", "section"), true);
	assert.throws(() => schema.validateFragment(incomplete), /requires at least 1/);
	schema.validateFragment(incomplete, { allowIncompleteContent: true });

	const validSection = schema.createNode("section", { content: [schema.createText("A")] });
	schema.validate(schema.createDocument([validSection], "article-1"));
	assert.throws(() => schema.createNode("section", { content: [schema.createText("A"), schema.createText("B"), schema.createText("C")] }), /allows at most 2/);
	assert.throws(() => new DocumentSchema({ topNodeType: "article", nodes: { article: { kind: "root", allowedChildGroups: ["missing"] }, text: { kind: "text" } } }), /unknown child group/);

	const defaultSchema = createDefaultDocumentSchema();
	const emptyList = defaultSchema.createNode("bulletList");
	const item = defaultSchema.createNode("listItem", { content: [defaultSchema.createNode("paragraph", { content: [defaultSchema.createText("assembled")] })] });
	using model = TextModel.create(defaultSchema, defaultSchema.createDocument([], "assembly-document"));
	model.dispatch(new DocumentTransaction().insertNode("assembly-document", 0, emptyList).insertNode(emptyList.id, 0, item));
	assert.equal(model.document.content[0]?.content[0]?.content[0]?.content[0]?.text, "assembled");
});

test("DocumentSchema expresses the Stanza group, typed-block, and line hierarchy", () => {
	const schema = new DocumentSchema({
		topNodeType: "article",
		nodes: {
			article: { kind: "root", content: [{ type: "group", min: 1 }] },
			group: { kind: "group", content: [{ group: "stanza-block", min: 1 }] },
			textBlock: { kind: "block", groups: ["stanza-block"], content: [{ type: "richLine", min: 1 }] },
			quoteBlock: { kind: "block", groups: ["stanza-block"], content: [{ type: "richLine", min: 1 }] },
			codeBlock: { kind: "block", groups: ["stanza-block"], content: [{ type: "codeLine", min: 1 }] },
			imageBlock: {
				kind: "block",
				groups: ["stanza-block"],
				content: [{ type: "captionLine", max: 1 }],
				validateAttributes: attrs => {
					if (typeof attrs.src !== "string" || attrs.src.length === 0) throw new TypeError("Image blocks require a source");
				},
			},
			richLine: { kind: "line", content: [{ type: "text", max: 1 }] },
			codeLine: { kind: "line", content: [{ type: "text", max: 1 }] },
			captionLine: { kind: "line", content: [{ type: "text", max: 1 }] },
			text: { kind: "text" },
		},
	});
	const line = (type: "richLine" | "codeLine" | "captionLine", text: string) => schema.createNode(type, {
		content: text.length > 0 ? [schema.createText(text)] : [],
	});
	const group = schema.createNode("group", { content: [
		schema.createNode("textBlock", { content: [line("richLine", "First"), line("richLine", "Second")] }),
		schema.createNode("quoteBlock", { content: [line("richLine", "Quoted")] }),
		schema.createNode("codeBlock", { content: [line("codeLine", "const value = 1;"), line("codeLine", "return value;")] }),
		schema.createNode("imageBlock", { attrs: { src: "image.png" }, content: [line("captionLine", "Figure 1")] }),
	] });
	const document = schema.createDocument([group]);
	using model = TextModel.create(schema, document);

	assert.equal(document.content[0]?.content.length, 4);
	assert.deepEqual(document.content[0]?.content.map(block => block.type), ["textBlock", "quoteBlock", "codeBlock", "imageBlock"]);
	assert.equal(document.content[0]?.content[2]?.content.length, 2);
	assert.equal(schema.getNodeSpec("group")?.kind, "group");
	assert.equal(schema.getNodeSpec("codeLine")?.kind, "line");
	assert.equal(model.getText(), "First\nSecond\nQuoted\nconst value = 1;\nreturn value;\n\uFFFC\nFigure 1");
	assert.equal(model.lineCount, 7);
	const codeBlock = group.content[2]!;
	const codeRegion = model.lineDocument.regions.get(`${codeBlock.id}:region`)!;
	assert.deepEqual({
		kind: codeRegion.kind,
		startLineId: codeRegion.startLineId,
		endLineId: codeRegion.endLineId,
		languageId: codeRegion.attrs.languageId,
	}, {
		kind: "code",
		startLineId: codeBlock.content[0]!.id,
		endLineId: codeBlock.content[1]!.id,
		languageId: "text",
	});
	assert.deepEqual(model.lineDocument.facets.forLine(codeBlock.content[1]!.id).map(facet => facet.kind), ["group", "codeBlock", "codeLine"]);
	assert.equal(model.lineDocument.atoms.values[0]?.kind, "image");
	const textChanges: { readonly reason: string; readonly changes: readonly { readonly rangeOffset: number; readonly rangeLength: number; readonly text: string }[] }[] = [];
	model.onDidChangeContent(change => textChanges.push(change));
	const firstCodeText = group.content[2]!.content[0]!.content[0]!;
	const textBeforeEdit = model.getText();
	model.dispatch(new DocumentTransaction().replaceText(firstCodeText.id, 0, firstCodeText.text!.length, "let value = 2;"));
	assert.equal(model.getLineContent((3) + 1), "let value = 2;");
	assert.equal(model.version, 2);
	assert.equal(textChanges[0]?.reason, "blocks");
	assert.ok((textChanges[0]?.changes[0]?.rangeOffset ?? 0) > 0);
	assert.ok((textChanges[0]?.changes[0]?.rangeLength ?? textBeforeEdit.length) < textBeforeEdit.length);
	const textEdit = textChanges[0]!.changes[0]!;
	assert.equal(textBeforeEdit.slice(0, textEdit.rangeOffset) + textEdit.text + textBeforeEdit.slice(textEdit.rangeOffset + textEdit.rangeLength), model.getText());
	const textBeforeAttributeChange = model.getText();
	model.dispatch(new DocumentTransaction().setNodeAttributes(group.content[2]!.id, { language: "rust" }));
	assert.equal(model.version, 3);
	assert.equal(model.getText(), textBeforeAttributeChange);
	assert.equal(model.lineDocument.regions.get(`${codeBlock.id}:region`)?.attrs.languageId, "rust");
	assert.equal(textChanges[1]?.reason, "blocks");
	assert.equal(textChanges[1]?.changes[0]?.rangeOffset, 0);
	assert.equal(textChanges[1]?.changes[0]?.rangeLength, textBeforeAttributeChange.length);
	assert.equal(textChanges[1]?.changes[0]?.text, textBeforeAttributeChange);
	assert.throws(() => model.reset("detached text"), /must update schema-backed Blocks/);
	assert.throws(() => schema.createDocument([schema.createNode("codeBlock", { content: [line("codeLine", "orphan")] })]), /cannot contain 'codeBlock'/);
});

test("TextModel projects nested schema nodes as orthogonal line facets", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("nested", { id: "text-1" })] });
	const listItem = schema.createNode("listItem", { id: "list-item-1", content: [paragraph] });
	const list = schema.createNode("bulletList", { id: "list-1", content: [listItem] });
	using model = TextModel.create(schema, schema.createDocument([list], "document-1"));

	assert.equal(model.getLineId(0), "paragraph-1");
	assert.deepEqual(model.lineDocument.facets.forLine("paragraph-1").map(facet => ({
		kind: facet.kind,
		nodeId: facet.attrs.nodeId,
	})), [
		{ kind: "bulletList", nodeId: "list-1" },
		{ kind: "listItem", nodeId: "list-item-1" },
		{ kind: "paragraph", nodeId: "paragraph-1" },
	]);
});

test("Plain TextModel uses the restricted line-document profile without structural sidecars", () => {
	using model = new TextModel("first\nsecond", { lineIds: ["first", "second"], metadata: { languageId: "typescript" } });

	assert.deepEqual(model.lineDocument.lines.values, [{ id: "first", text: "first" }, { id: "second", text: "second" }]);
	assert.deepEqual(model.lineDocument.marks.values, []);
	assert.deepEqual(model.lineDocument.atoms.values, []);
	assert.deepEqual(model.lineDocument.facets.values, []);
	assert.deepEqual(model.lineDocument.regions.values, []);
	assert.deepEqual(model.lineDocument.relations.values, []);
	assert.equal(model.lineDocument.metadata.languageId, "typescript");
	model.reset("first\nsecond\nthird");
	assert.deepEqual(model.lineDocument.lines.values.map(line => line.text), ["first", "second", "third"]);
});

test("TextModel retains one empty logical line for an empty schema-backed document", () => {
	const schema = createDefaultDocumentSchema();
	using model = TextModel.create(schema, schema.createDocument([], "empty-document"));

	assert.deepEqual(model.lineDocument.lines.values, [{ id: "empty-document:line", text: "" }]);
	assert.deepEqual(model.lineDocument.facets.values, []);
});

test("DocumentSchema enforces ordered content terms for custom academic nodes", () => {
	const schema = new DocumentSchema({
		topNodeType: "article",
		nodes: {
			article: { kind: "root", content: [{ type: "title", min: 1, max: 1 }, { type: "abstract", max: 1 }, { group: "section" }] },
			title: { kind: "block", allowedChildren: ["text"] },
			abstract: { kind: "block", allowedChildren: ["text"] },
			section: { kind: "block", groups: ["section"], content: [{ type: "text", min: 1 }] },
			text: { kind: "text" },
		},
	});
	const title = schema.createNode("title", { content: [schema.createText("Title")] });
	const abstract = schema.createNode("abstract", { content: [schema.createText("Abstract")] });
	const section = schema.createNode("section", { content: [schema.createText("Section")] });

	schema.validate(schema.createDocument([title, abstract, section], "article-1"));
	assert.equal(schema.canContainChild("article", "section"), true);
	assert.equal(schema.canContainChild("article", "text"), false);
	assert.throws(() => schema.createDocument([abstract, title], "invalid-order"), /content does not match/);
	assert.throws(() => schema.createDocument([title, section, abstract], "invalid-tail"), /content does not match/);
	const incomplete = schema.createNode("section");
	schema.validateFragment(incomplete, { allowIncompleteContent: true });
	assert.throws(() => schema.validateFragment(incomplete), /content does not match/);
	assert.throws(() => new DocumentSchema({ topNodeType: "article", nodes: { article: { kind: "root", content: [{ type: "missing" }] }, text: { kind: "text" } } }), /unknown child/);
});

test("Stanza Academic schema composes title, abstract, and section wrappers", () => {
	const schema = createAcademicDocumentSchema();
	const empty = createEmptyAcademicDocument(schema);
	assert.deepEqual(empty.content.map(node => node.type), ["title", "abstract"]);
	schema.validate(empty);

	const title = schema.createNode("title", { content: [schema.createNode("heading", { content: [schema.createText("Paper title")] })] });
	const abstract = schema.createNode("abstract", { content: [schema.createNode("paragraph", { content: [schema.createText("Summary")] })] });
	const section = schema.createNode("section", { content: [schema.createNode("heading", { content: [schema.createText("Introduction")] }), schema.createNode("paragraph", { content: [schema.createText("Body")] })] });
	const document = schema.createDocument([title, abstract, section]);
	assert.equal(document.content[2]?.type, "section");
	assert.equal(schema.canContainChild(schema.topNodeType, "paragraph"), true);
	assert.throws(() => schema.createDocument([abstract, title]), /content does not match its schema/);
	assert.throws(() => schema.createDocument([section, title]), /content does not match its schema/);
});

test("Stanza builds an outline across nested structured nodes", () => {
	const schema = createAcademicDocumentSchema();
	const title = schema.createNode("title", { id: "outline-title", content: [schema.createNode("heading", { id: "outline-title-heading", content: [schema.createText("Paper title", { id: "outline-title-text" })] })] });
	const abstract = schema.createNode("abstract", { id: "outline-abstract", content: [schema.createNode("paragraph", { id: "outline-abstract-paragraph", content: [schema.createText("Summary", { id: "outline-abstract-text" })] })] });
	const sectionHeading = schema.createNode("heading", { id: "outline-section-heading", content: [schema.createText("Introduction", { id: "outline-section-text" })] });
	const nestedHeading = schema.createNode("heading", { id: "outline-nested-heading", attrs: { level: 2 }, content: [schema.createText("Background", { id: "outline-nested-text" })] });
	const section = schema.createNode("section", { id: "outline-section", content: [sectionHeading, schema.createNode("blockquote", { id: "outline-quote", content: [nestedHeading] })] });
	const document = schema.createDocument([title, abstract, section], "outline-document");

	assert.deepEqual(buildDocumentOutline(document).map(entry => ({ nodeId: entry.nodeId, parentHeadingId: entry.parentHeadingId, depth: entry.depth, level: entry.level, title: entry.title })), [
		{ nodeId: "outline-title-heading", parentHeadingId: undefined, depth: 0, level: 1, title: "Paper title" },
		{ nodeId: "outline-section-heading", parentHeadingId: undefined, depth: 0, level: 1, title: "Introduction" },
		{ nodeId: "outline-nested-heading", parentHeadingId: "outline-section-heading", depth: 1, level: 2, title: "Background" },
	]);
});

test("Academic citation nodes insert, select, delete, and export as inline atoms", () => {
	const schema = createAcademicDocumentSchema();
	const paragraph = schema.createNode("paragraph", { id: "citation-paragraph", content: [schema.createText("Read ", { id: "citation-before" }), schema.createText("now", { id: "citation-after" })] });
	const document = schema.createDocument([paragraph], "citation-document");
	using model = TextModel.create(schema, document);
	const command = createInsertCitationCommand(schema, model.document, paragraph.id, textSelection({ nodeId: "citation-before", offset: 5 }), "smith-2024", "[Smith 2024]");
	assert.ok(command);
	model.dispatch(command.transaction);

	const content = model.document.content[0]?.content ?? [];
	const citation = content.find(node => node.type === "citation");
	assert.equal(citation?.attrs.key, "smith-2024");
	assert.deepEqual(content.map(node => node.type), ["text", "citation", "text"]);
	assert.equal(documentSelectionToText(model.document, allSelection()), "Read [Smith 2024]now");
	model.setSelection(nodeSelection(citation!.id));
	const deletion = createDeleteNodeSelectionCommand(model.document, model.selection!);
	assert.ok(deletion);
	model.dispatch(deletion.transaction);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.text ?? node.type), ["Read ", "now"]);
});

test("Citation references compose a bibliography and resolve duplicate and missing keys", () => {
	const schema = createAcademicDocumentSchema();
	const citation = schema.createNode("citation", { id: "reference-citation", attrs: { key: "smith-2024" } });
	const missingCitation = schema.createNode("citation", { id: "missing-citation", attrs: { key: "missing-2024" } });
	const paragraph = schema.createNode("paragraph", { id: "reference-paragraph", content: [citation, schema.createText(" and "), missingCitation] });
	const firstReference = schema.createNode("reference", { id: "reference-one", attrs: { key: "smith-2024" }, content: [schema.createNode("paragraph", { content: [schema.createText("Smith, first entry")] })] });
	const duplicateReference = schema.createNode("reference", { id: "reference-two", attrs: { key: "smith-2024" }, content: [schema.createNode("paragraph", { content: [schema.createText("Smith, duplicate entry")] })] });
	const bibliography = schema.createNode("bibliography", { id: "reference-bibliography", content: [firstReference, duplicateReference] });
	const document = schema.createDocument([bibliography, paragraph], "reference-document");

	const index = buildReferenceIndex(document);
	assert.deepEqual(index.references.map(reference => ({ key: reference.key, ordinal: reference.ordinal, label: reference.label })), [
		{ key: "smith-2024", ordinal: 1, label: "Smith, first entry" },
		{ key: "smith-2024", ordinal: 2, label: "Smith, duplicate entry" },
	]);
	assert.deepEqual(index.citations.map(citation => ({ key: citation.key, ordinal: citation.ordinal })), [
		{ key: "smith-2024", ordinal: 1 },
		{ key: "missing-2024", ordinal: undefined },
	]);
	assert.deepEqual(index.unresolvedKeys, ["missing-2024"]);
	assert.deepEqual(index.duplicateKeys, ["smith-2024"]);
});

test("Citation reference command creates and appends a bibliography", () => {
	const schema = createAcademicDocumentSchema();
	const paragraph = schema.createNode("paragraph", { id: "reference-command-paragraph", content: [schema.createText("Body")] });
	const document = schema.createDocument([paragraph], "reference-command-document");
	using model = TextModel.create(schema, document, { plugins: [createReferenceIndexPlugin()] });

	const first = createInsertReferenceCommand(schema, model.document, "smith-2024", "Smith, 2024");
	assert.ok(first);
	model.dispatch(first.transaction);
	const bibliography = model.document.content.find(node => node.type === "bibliography");
	assert.ok(bibliography);
	assert.deepEqual(bibliography.content.map(node => node.attrs.key), ["smith-2024"]);
	assert.equal(model.getPluginState(REFERENCE_INDEX_KEY)?.references[0]?.key, "smith-2024");

	const second = createInsertReferenceCommand(schema, model.document, "doe-2023", "Doe, 2023");
	assert.ok(second);
	model.dispatch(second.transaction);
	const updatedBibliography = model.document.content.find(node => node.type === "bibliography");
	assert.deepEqual(updatedBibliography?.content.map(node => node.attrs.key), ["smith-2024", "doe-2023"]);
});

test("TextModel handles insertion, attributes, movement, and deletion as one history unit", () => {
	const schema = createDefaultDocumentSchema();
	const document = createDocument(schema);
	const secondParagraph = schema.createNode("paragraph", {
		id: "paragraph-2",
		content: [schema.createText("Second", { id: "text-2" })],
	});
	using model = TextModel.create(schema, document);

	model.dispatch(new DocumentTransaction()
		.insertNode("document-1", 1, secondParagraph)
		.setNodeAttributes("paragraph-1", { alignment: "center" })
		.moveNode("paragraph-2", "document-1", 0));

	assert.deepEqual(model.document.content.slice(0, 2).map(node => node.id), ["paragraph-2", "paragraph-1"]);
	assert.equal(model.document.content[1]?.attrs.alignment, "center");
	model.undoBlocks();
	assert.deepEqual(model.document.content.map(node => node.id), ["paragraph-1", "code-1"]);
	assert.equal(model.document.content[0]?.attrs.alignment, undefined);
});

test("TextModel rejects invalid transactions without partial mutation", () => {
	const schema = createDefaultDocumentSchema();
	using model = TextModel.create(schema, createDocument(schema));
	const before = serializeDocument(model.document, schema);

	assert.throws(() => model.dispatch(new DocumentTransaction()
		.replaceText("text-1", 0, 100, "invalid")
		.setNodeAttributes("paragraph-1", { alignment: "left" })), /must satisfy/);
	assert.equal(serializeDocument(model.document, schema), before);
	assert.equal(model.canUndoBlocks, false);
});

test("Block documents round-trip through a versioned serialization envelope", () => {
	const schema = createDefaultDocumentSchema();
	const document = createDocument(schema);
	const encoded = serializeDocument(document, schema, true);
	const decoded = deserializeDocument(encoded, schema);

	assert.deepEqual(decoded, document);
	assert.throws(() => deserializeDocument("{\"format\":\"ash.document\",\"version\":99}", schema), DocumentSerializationError);
	assert.throws(() => deserializeDocument("not json", schema), DocumentSerializationError);
});

test("Stanza serializes every transaction step and preserves transport metadata", () => {
	const schema = createDefaultDocumentSchema();
	const document = createDocument(schema);
	const inserted = schema.createNode("paragraph", { id: "serialized-paragraph", content: [schema.createText("Inserted", { id: "serialized-text" })] });
	const transaction = new DocumentTransaction()
		.replaceText("text-1", 1, 3, "X", [{ type: "strong", attrs: {} }])
		.insertNode("document-1", 1, inserted)
		.deleteNode(inserted.id)
		.moveNode("paragraph-1", "document-1", 1)
		.setNodeAttributes("paragraph-1", { alignment: "center" })
		.setNodeMarks("text-1", [{ type: "em", attrs: {} }])
		.setNodeType("paragraph-1", "heading", { level: 2 })
		.withSelection(textSelection({ nodeId: "text-1", offset: 2 }))
		.withStoredMarks([{ type: "strong", attrs: {} }])
		.withHistoryGroup("remote-edit")
		.withMeta("transport", { peerId: "peer-a", sequence: 3 });
	const decoded = deserializeDocumentTransaction(serializeDocumentTransaction(transaction, schema), schema);

	assert.deepEqual(decoded.steps, transaction.steps);
	assert.deepEqual(decoded.selection, transaction.selection);
	assert.deepEqual(decoded.storedMarks, transaction.storedMarks);
	assert.equal(decoded.historyGroup, "remote-edit");
	assert.deepEqual(decoded.getMeta("transport"), { peerId: "peer-a", sequence: 3 });
	assert.throws(() => deserializeDocumentTransaction("not json", schema), DocumentSerializationError);
});

test("TextModel applies remote transactions outside local history", () => {
	const schema = createDefaultDocumentSchema();
	const key = new DocumentPluginKey<readonly string[]>("remote-origins");
	const plugin = createDocumentPlugin(key, {
		init: () => [],
		apply: (value, context) => [...value, context.origin],
	});
	using model = TextModel.create(schema, createDocument(schema), { plugins: [plugin] });
	model.dispatch(new DocumentTransaction().replaceText("text-1", 0, 0, "L"));
	assert.equal(model.canUndoBlocks, true);

	const remote = deserializeDocumentTransaction(serializeDocumentTransaction(new DocumentTransaction()
		.replaceText("text-1", 0, 1, "R")
		.withSelection(textSelection({ nodeId: "text-1", offset: 1 }))
		.withStoredMarks([{ type: "strong", attrs: {} }]), schema), schema);
	const change = model.dispatchRemote(remote);

	assert.equal(change?.origin, "remote");
	assert.equal(model.document.content[0]?.content[0]?.text, "RHello");
	assert.deepEqual(model.selection, textSelection({ nodeId: "text-1", offset: 1 }));
	assert.deepEqual(model.storedMarks, [{ type: "strong", attrs: {} }]);
	assert.equal(model.canUndoBlocks, false);
	assert.equal(model.canRedoBlocks, false);
	assert.deepEqual(model.getPluginState(key), ["user", "remote"]);
});

test("Stanza converts inline and cross-block selections into clipboard text", () => {
	const schema = createDefaultDocumentSchema();
	const first = schema.createNode("paragraph", {
		id: "paragraph-1",
		content: [
			schema.createText("A", { id: "text-1" }),
			schema.createNode("hardBreak", { id: "break-1" }),
			schema.createText("B", { id: "text-2" }),
		],
	});
	const second = schema.createNode("paragraph", {
		id: "paragraph-2",
		content: [schema.createText("C", { id: "text-3" })],
	});
	const document = schema.createDocument([first, second], "document-1");
	assert.equal(documentSelectionToText(document, textSelection({ nodeId: "text-1", offset: 0 }, { nodeId: "text-2", offset: 1 })), "A\nB");
	assert.equal(documentSelectionToText(document, textSelection({ nodeId: "text-1", offset: 0 }, { nodeId: "text-3", offset: 1 })), "A\nB\nC");
});

test("Stanza supports whole-document clipboard text, fragments, replacement, and deletion", () => {
	const schema = createDefaultDocumentSchema();
	const source = schema.createDocument([
		schema.createNode("paragraph", { id: "source-paragraph-1", content: [schema.createText("First", { id: "source-text-1" })] }),
		schema.createNode("heading", { id: "source-heading-1", content: [schema.createText("Second", { id: "source-text-2" })] }),
	], "source-document");
	const selection = allSelection();
	assert.equal(documentSelectionToText(source, selection), "First\nSecond");
	const fragment = extractDocumentFragment(schema, source, selection);
	assert.ok(fragment);
	assert.deepEqual(fragment.content.map(node => node.id), ["source-paragraph-1", "source-heading-1"]);

	const targetParagraph = schema.createNode("paragraph", { id: "target-paragraph-1", content: [schema.createText("Target", { id: "target-text-1" })] });
	using model = TextModel.create(schema, schema.createDocument([targetParagraph], "target-document"), { selection });
	const paste = createInsertFragmentCommand(schema, model.document, targetParagraph.id, selection, fragment);
	assert.ok(paste);
	model.dispatch(paste.transaction);
	assert.deepEqual(model.document.content.map(node => node.content[0]?.text ?? ""), ["First", "Second"]);
	assert.notEqual(model.document.content[0]?.id, source.content[0]?.id);

	const replace = createReplaceTextCommand(schema, model.document, model.document.content[0]!.id, allSelection(), "A\nB");
	assert.ok(replace);
	model.dispatch(replace.transaction);
	assert.deepEqual(model.document.content.map(node => node.content[0]?.text ?? ""), ["A", "B"]);
	const clear = createDeleteInlineSelectionCommand(schema, model.document, model.document.content[0]!.id, allSelection());
	assert.ok(clear);
	model.dispatch(clear.transaction);
	assert.equal(model.document.content.length, 1);
	assert.equal(model.document.content[0]?.type, "paragraph");
	assert.equal(model.document.content[0]?.content.length, 0);
	assert.equal(model.selection, undefined);
});

test("Stanza extracts, serializes, and inserts structured clipboard fragments", () => {
	const schema = createDefaultDocumentSchema();
	const sourceParagraph = schema.createNode("paragraph", {
		id: "source-paragraph",
		content: [
			schema.createText("A", { id: "source-text-1", marks: [{ type: "strong", attrs: {} }] }),
			schema.createNode("hardBreak", { id: "source-break" }),
			schema.createText("B", { id: "source-text-2", marks: [{ type: "link", attrs: { href: "https://example.test" } }] }),
		],
	});
	const sourceDocument = schema.createDocument([sourceParagraph], "source-document");
	const fragment = extractDocumentFragment(schema, sourceDocument, textSelection({ nodeId: "source-text-1", offset: 0 }, { nodeId: "source-text-2", offset: 1 }));
	assert.ok(fragment);
	assert.deepEqual(fragment.content[0]?.content.map(node => node.type), ["text", "hardBreak", "text"]);
	const encoded = serializeDocumentFragment(fragment, schema);
	const decoded = deserializeDocumentFragment(encoded, schema);
	assert.deepEqual(decoded, fragment);

	const target = schema.createNode("paragraph", {
		id: "target-paragraph",
		content: [schema.createText("Target", { id: "target-text" })],
	});
	using model = TextModel.create(schema, schema.createDocument([target], "target-document"));
	const insert = createInsertFragmentCommand(schema, model.document, "target-paragraph", textSelection({ nodeId: "target-text", offset: 3 }), decoded);
	assert.ok(insert);
	model.dispatch(insert.transaction);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.text ?? node.type), ["Tar", "A", "hardBreak", "B", "get"]);
	assert.notEqual(model.document.content[0]?.content[1]?.id, "source-text-1");
	assert.equal(model.document.content[0]?.content[1]?.marks[0]?.type, "strong");
	assert.throws(() => deserializeDocumentFragment("{\"format\":\"ash.document.fragment\",\"version\":1,\"content\":[{\"id\":\"bad\",\"type\":\"unknown\",\"attrs\":{},\"content\":[],\"marks\":[]}]}", schema), /fragment/);
});

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
