import { DocumentTextModel } from '../../../../../extensions/academy/common/model/documentTextModel.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { Position } from '../../common/core/position.js';
import { createDefaultDocumentSchema, DocumentSchema } from "../../../../../extensions/academy/common/model/documentSchema.js";
import { createDeleteReferenceCommand, createInsertCitationCommand, createInsertReferenceCommand, createUpdateReferenceCommand } from "../../../../../extensions/academy/browser/contrib/citation/common/citationCommands.js";
import { buildReferenceIndex, createReferenceIndexPlugin, REFERENCE_INDEX_KEY } from "../../../../../extensions/academy/browser/contrib/citation/common/references.js";
import { createAcademyDocumentSchema, createEmptyAcademyDocument } from "../../../../../extensions/academy/browser/contrib/academy/common/schema.js";
import { TextModel } from "../../common/model/textModel.js";
import { createDocumentDecoration, DocumentDecorationSet } from "../../../../../extensions/academy/common/model/documentDecoration.js";
import { buildDocumentOutline } from "../../../../../extensions/academy/common/model/documentOutline.js";
import { documentContentSize, documentNodeSize, documentPointToPosition } from "../../../../../extensions/academy/common/core/documentPosition.js";
import { createDocumentPlugin, DocumentPluginKey } from "../../../../../extensions/academy/common/model/documentPlugin.js";
import { documentSelectionToText, extractDocumentFragment, deserializeDocument, deserializeDocumentFragment, DocumentSerializationError, serializeDocument, serializeDocumentFragment } from "../../../../../extensions/academy/common/model/documentSerialization.js";
import { allSelection, nodeSelection, textSelection } from "../../../../../extensions/academy/common/core/documentSelection.js";
import { DocumentTransaction } from "../../../../../extensions/academy/common/model/documentTransaction.js";
import { deserializeDocumentTransaction, serializeDocumentTransaction } from "../../../../../extensions/academy/common/model/documentTransactionSerialization.js";
import { createDeleteInlineSelectionCommand, createDeleteNodeSelectionCommand, createInsertFragmentCommand, createReplaceTextCommand } from "../../../../../extensions/academy/common/commands/documentCommands.js";

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
	const key = new DocumentPluginKey<{ readonly origins: readonly string[]; readonly selections: readonly string[]; readonly versions: readonly number[]; }>("audit");
	const plugin = createDocumentPlugin(key, {
		init: context => ({ origins: [], selections: [], versions: [context.version] }),
		apply: (value, context) => ({ origins: [...value.origins, context.origin], selections: value.selections, versions: [...value.versions, context.version] }),
		applySelection: (value, context) => ({ origins: value.origins, selections: [...value.selections, context.selection?.kind ?? "none"], versions: value.versions }),
	});
	using model = DocumentTextModel.create(schema, createDocument(schema), { plugins: [plugin] });

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
	using model = DocumentTextModel.create(schema, createDocument(schema), { plugins: [plugin] });
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
	}, {
		decorations: (state, context) => {
			assert.equal(context.state, state);
			assert.equal(context.version, 1);
			return state;
		}
	});
	using model = DocumentTextModel.create(schema, document, { plugins: [plugin] });

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
	using model = DocumentTextModel.create(schema, createDocument(schema), { plugins: [plugin] });
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
	using model = DocumentTextModel.create(schema, createDocument(schema), { plugins: [plugin] });
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

test("Stanza converts nested text points to absolute positions", () => {
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
	assert.throws(() => documentPointToPosition(document, schema, { nodeId: "image-1", offset: 0 }), /must target a text node/);
});

test("TextModel applies text transactions and preserves transaction-level undo", () => {
	const schema = createDefaultDocumentSchema();
	using model = DocumentTextModel.create(schema, createDocument(schema));
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
	using model = DocumentTextModel.create(schema, schema.createDocument([first, second], "document-1"), { selection: textSelection({ nodeId: "text-1", offset: 5 }) });

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
	using model = DocumentTextModel.create(schema, schema.createDocument([paragraph], "document-1"), { selection: textSelection({ nodeId: "text-1", offset: 1 }) });

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
	using model = DocumentTextModel.create(defaultSchema, defaultSchema.createDocument([], "assembly-document"));
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
	const group = schema.createNode("group", {
		content: [
			schema.createNode("textBlock", { content: [line("richLine", "First"), line("richLine", "Second")] }),
			schema.createNode("quoteBlock", { content: [line("richLine", "Quoted")] }),
			schema.createNode("codeBlock", { content: [line("codeLine", "const value = 1;"), line("codeLine", "return value;")] }),
			schema.createNode("imageBlock", { attrs: { src: "image.png" }, content: [line("captionLine", "Figure 1")] }),
		]
	});
	const document = schema.createDocument([group]);
	using model = DocumentTextModel.create(schema, document);

	assert.equal(document.content[0]?.content.length, 4);
	assert.deepEqual(document.content[0]?.content.map(block => block.type), ["textBlock", "quoteBlock", "codeBlock", "imageBlock"]);
	assert.equal(document.content[0]?.content[2]?.content.length, 2);
	assert.equal(schema.getNodeSpec("group")?.kind, "group");
	assert.equal(schema.getNodeSpec("codeLine")?.kind, "line");
	assert.equal(model.getText(), "First\nSecond\nQuoted\nconst value = 1;\nreturn value;\n\uFFFC\nFigure 1");
	assert.equal(model.lineCount, 7);
	const codeBlock = group.content[2]!;
	const codeLineId = codeBlock.content[0]!.id;
	assert.equal(model.getLineId(3), codeLineId);
	assert.deepEqual(model.textPositionAt({ lineId: codeLineId, offset: 6 }), new Position(4, 7));
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
	const textChanges: { readonly reason: string; readonly changes: readonly { readonly rangeOffset: number; readonly rangeLength: number; readonly text: string; }[]; }[] = [];
	model.onDidChangeContent(change => textChanges.push(change));
	const firstCodeText = group.content[2]!.content[0]!.content[0]!;
	const textBeforeEdit = model.getText();
	model.dispatch(new DocumentTransaction().replaceText(firstCodeText.id, 0, firstCodeText.text!.length, "let value = 2;"));
	assert.equal(model.getLineContent((3) + 1), "let value = 2;");
	assert.equal(model.version, 2);
	assert.equal(textChanges[0]?.reason, "extension");
	assert.ok((textChanges[0]?.changes[0]?.rangeOffset ?? 0) > 0);
	assert.ok((textChanges[0]?.changes[0]?.rangeLength ?? textBeforeEdit.length) < textBeforeEdit.length);
	const textEdit = textChanges[0]!.changes[0]!;
	assert.equal(textBeforeEdit.slice(0, textEdit.rangeOffset) + textEdit.text + textBeforeEdit.slice(textEdit.rangeOffset + textEdit.rangeLength), model.getText());
	const textBeforeAttributeChange = model.getText();
	model.dispatch(new DocumentTransaction().setNodeAttributes(group.content[2]!.id, { language: "rust" }));
	assert.equal(model.version, 3);
	assert.equal(model.getText(), textBeforeAttributeChange);
	assert.equal(model.lineDocument.regions.get(`${codeBlock.id}:region`)?.attrs.languageId, "rust");
	assert.equal(model.getLineId(3), codeLineId);
	assert.deepEqual(model.textPositionAt({ lineId: codeLineId, offset: 6 }), new Position(4, 7));
	assert.equal(textChanges[1]?.reason, "extension");
	assert.equal(textChanges[1]?.changes[0]?.rangeOffset, 0);
	assert.equal(textChanges[1]?.changes[0]?.rangeLength, textBeforeAttributeChange.length);
	assert.equal(textChanges[1]?.changes[0]?.text, textBeforeAttributeChange);
	assert.throws(() => model.reset("detached text"), /must use the extension transaction owner/);
	assert.throws(() => schema.createDocument([schema.createNode("codeBlock", { content: [line("codeLine", "orphan")] })]), /cannot contain 'codeBlock'/);
});

test("TextModel projects nested schema nodes as orthogonal line facets", () => {
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("nested", { id: "text-1" })] });
	const listItem = schema.createNode("listItem", { id: "list-item-1", content: [paragraph] });
	const list = schema.createNode("bulletList", { id: "list-1", content: [listItem] });
	using model = DocumentTextModel.create(schema, schema.createDocument([list], "document-1"));

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
	using model = DocumentTextModel.create(schema, schema.createDocument([], "empty-document"));

	assert.deepEqual(model.lineDocument.lines.values, [{ id: "empty-document:line", text: "" }]);
	assert.deepEqual(model.lineDocument.facets.values, []);
});

test("DocumentSchema enforces ordered content terms for custom academy nodes", () => {
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

test("Stanza Academy schema composes title, abstract, and section wrappers", () => {
	const schema = createAcademyDocumentSchema();
	const empty = createEmptyAcademyDocument(schema);
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
	const schema = createAcademyDocumentSchema();
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

test("Academy citation nodes insert, select, delete, and export as inline atoms", () => {
	const schema = createAcademyDocumentSchema();
	const paragraph = schema.createNode("paragraph", { id: "citation-paragraph", content: [schema.createText("Read ", { id: "citation-before" }), schema.createText("now", { id: "citation-after" })] });
	const document = schema.createDocument([paragraph], "citation-document");
	using model = DocumentTextModel.create(schema, document);
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
	const schema = createAcademyDocumentSchema();
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
	const schema = createAcademyDocumentSchema();
	const paragraph = schema.createNode("paragraph", { id: "reference-command-paragraph", content: [schema.createText("Body")] });
	const document = schema.createDocument([paragraph], "reference-command-document");
	using model = DocumentTextModel.create(schema, document, { plugins: [createReferenceIndexPlugin()] });

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

test("Citation insertion trims keys and reference insertion rejects normalized duplicates", () => {
	const schema = createAcademyDocumentSchema();
	const paragraph = schema.createNode("paragraph", { content: [schema.createText("Body", { id: "trim-body" })] });
	using model = DocumentTextModel.create(schema, schema.createDocument([paragraph]));
	const selection = textSelection({ nodeId: "trim-body", offset: 4 });
	assert.equal(createInsertCitationCommand(schema, model.document, paragraph.id, selection, " \t "), undefined);
	assert.equal(createInsertReferenceCommand(schema, model.document, " \n ", "Blank"), undefined);
	const citation = createInsertCitationCommand(schema, model.document, paragraph.id, selection, " smith \t", "[Explicit]");
	assert.ok(citation);
	assert.ok(model.dispatch(citation.transaction));
	assert.equal(model.document.content[0]?.content.find(node => node.type === "citation")?.attrs.key, "smith");
	const reference = createInsertReferenceCommand(schema, model.document, " smith ", " Smith entry ");
	assert.ok(reference);
	assert.ok(model.dispatch(reference.transaction));
	const before = model.document;
	assert.equal(createInsertReferenceCommand(schema, before, "\tsmith ", "Duplicate"), undefined);
	assert.equal(model.document, before);
	assert.deepEqual(buildReferenceIndex(before).references.map(entry => [entry.key, entry.label]), [["smith", "Smith entry"]]);
});

test("Reference rename updates all nested citation keys atomically and preserves identities and labels", () => {
	const schema = createAcademyDocumentSchema();
	const explicit = schema.createNode("citation", { id: "rename-explicit", attrs: { key: "old", label: "[Custom label]", source: "keep" } });
	const implicit = schema.createNode("citation", { id: "rename-implicit", attrs: { key: "old" } });
	const unrelated = schema.createNode("citation", { id: "rename-unrelated", attrs: { key: "other", label: "[Other]" } });
	const body = schema.createNode("blockquote", { content: [schema.createNode("paragraph", { content: [schema.createText("Keep", { marks: [{ type: "strong", attrs: {} }] }), explicit, implicit, unrelated] })] });
	const label = schema.createNode("paragraph", { id: "rename-label", attrs: { alignment: "center" }, content: [schema.createText("Old label", { marks: [{ type: "strong", attrs: {} }] })] });
	const reference = schema.createNode("reference", { id: "rename-reference", attrs: { key: "old", source: "retained" }, content: [label] });
	const bibliography = schema.createNode("bibliography", { id: "rename-bibliography", attrs: { source: "retained" }, content: [reference] });
	const document = schema.createDocument([bibliography, body]);
	const snapshots: string[][] = [];
	const audit = createDocumentPlugin(new DocumentPluginKey<number>("reference-rename-audit"), {
		init: () => 0,
		apply: (value, context) => {
			const index = buildReferenceIndex(context.document);
			snapshots.push([index.references[0]!.key, ...index.citations.map(entry => entry.key)]);
			return value + 1;
		},
	});
	using model = DocumentTextModel.create(schema, document, { plugins: [createReferenceIndexPlugin(), audit] });
	const command = createUpdateReferenceCommand(schema, model.document, " old ", " new ", " New label ");
	assert.ok(command);
	const decoded = deserializeDocumentTransaction(serializeDocumentTransaction(command.transaction, schema), schema);
	assert.deepEqual(decoded.steps, command.transaction.steps);
	assert.ok(model.dispatch(decoded));
	assert.equal(model.version, 2);
	assert.deepEqual(snapshots, [["new", "new", "new", "other"]]);
	const updated = model.document;
	assert.deepEqual(updated.content[0]?.attrs, bibliography.attrs);
	assert.equal(updated.content[0]?.id, bibliography.id);
	const updatedReference = updated.content[0]!.content[0]!;
	assert.equal(updatedReference.id, reference.id);
	assert.deepEqual(updatedReference.attrs, { ...reference.attrs, key: "new" });
	assert.equal(updatedReference.content[0]?.id, label.id);
	assert.deepEqual(updatedReference.content[0]?.attrs, label.attrs);
	assert.deepEqual(updatedReference.content[0]?.content.map(node => [node.text, node.marks]), [["New label", []]]);
	const updatedBody = updated.content[1]!.content[0]!.content;
	assert.deepEqual(updatedBody[0], body.content[0]!.content[0]);
	assert.deepEqual(updatedBody[1], { ...explicit, attrs: { ...explicit.attrs, key: "new" } });
	assert.deepEqual(updatedBody[2], { ...implicit, attrs: { ...implicit.attrs, key: "new" } });
	assert.deepEqual(updatedBody[3], unrelated);
	assert.deepEqual(model.getPluginState(REFERENCE_INDEX_KEY)?.unresolvedKeys, ["other"]);
	assert.deepEqual(deserializeDocument(serializeDocument(updated, schema), schema), updated);
	assert.ok(model.undoBlocks());
	assert.deepEqual(model.document, document);
	assert.equal(model.canUndoBlocks, false);
	assert.ok(model.redoBlocks());
	assert.deepEqual(model.document, updated);
});

test("Reference label-only edits preserve keys and reject blank, missing, colliding and ambiguous keys without mutation", () => {
	const schema = createAcademyDocumentSchema();
	const reference = schema.createNode("reference", { attrs: { key: "old" }, content: [schema.createNode("paragraph", { id: "label-only-paragraph", content: [schema.createText("Before")] })] });
	const other = schema.createNode("reference", { attrs: { key: " occupied " }, content: [schema.createNode("paragraph")] });
	const citation = schema.createNode("citation", { attrs: { key: "old", label: "" } });
	const document = schema.createDocument([schema.createNode("bibliography", { content: [reference, other] }), schema.createNode("paragraph", { content: [citation] })]);
	using model = DocumentTextModel.create(schema, document);
	const before = model.document;
	for (const [key, newKey] of [["old", " occupied "], ["old", " \t "], [" \n ", "new"], ["missing", "new"]]) {
		assert.equal(createUpdateReferenceCommand(schema, model.document, key, newKey, "Changed"), undefined);
	}
	for (const key of ["", " \t ", "missing"]) assert.equal(createDeleteReferenceCommand(schema, model.document, key), undefined);
	assert.equal(model.document, before);
	assert.equal(model.version, 1);
	assert.equal(model.canUndoBlocks, false);
	const labelOnly = createUpdateReferenceCommand(schema, model.document, " old ", " old ", " After ");
	assert.ok(labelOnly);
	assert.ok(model.dispatch(labelOnly.transaction));
	assert.deepEqual(model.document.content[1]?.content[0], citation);
	assert.equal(model.document.content[0]?.content[0]?.attrs.key, "old");
	assert.equal(model.document.content[0]?.content[0]?.content[0]?.id, "label-only-paragraph");
	assert.equal(model.document.content[0]?.content[0]?.content[0]?.content[0]?.text, "After");
	const clear = createUpdateReferenceCommand(schema, model.document, "old", "old", " \t ");
	assert.ok(clear);
	assert.ok(model.dispatch(clear.transaction));
	assert.deepEqual(model.document.content[0]?.content[0]?.content[0]?.content, []);

	const duplicate = schema.createNode("reference", { attrs: { key: " old " }, content: [schema.createNode("paragraph")] });
	const ambiguous = schema.createDocument([schema.createNode("bibliography", { content: [reference, duplicate] })]);
	using duplicateModel = DocumentTextModel.create(schema, ambiguous);
	const beforeAmbiguous = duplicateModel.document;
	assert.equal(createInsertReferenceCommand(schema, beforeAmbiguous, "old", "Duplicate"), undefined);
	assert.equal(createUpdateReferenceCommand(schema, beforeAmbiguous, " old ", "new", "Changed"), undefined);
	assert.equal(createDeleteReferenceCommand(schema, beforeAmbiguous, "old"), undefined);
	assert.equal(duplicateModel.document, beforeAmbiguous);
	assert.equal(duplicateModel.canUndoBlocks, false);
	assert.equal(buildReferenceIndex(ambiguous).references.length, 2);
	assert.deepEqual(deserializeDocument(serializeDocument(ambiguous, schema), schema), ambiguous);
});

test("Reference key-only edits preserve formatted label runs and empty labels stay empty", () => {
	const schema = createAcademyDocumentSchema();
	const paragraph = schema.createNode('paragraph', { content: [schema.createText('Styled', { marks: [{ type: 'strong', attrs: {} }] }), schema.createText(' entry')] });
	const reference = schema.createNode('reference', { attrs: { key: 'old' }, content: [paragraph] });
	const empty = schema.createNode('reference', { attrs: { key: 'empty' }, content: [schema.createNode('paragraph')] });
	using model = DocumentTextModel.create(schema, schema.createDocument([schema.createNode('bibliography', { content: [reference, empty] })]));
	const update = createUpdateReferenceCommand(schema, model.document, 'old', 'new', 'Styled entry');
	assert.ok(update);
	model.dispatch(update.transaction);
	assert.deepEqual(model.document.content[0]!.content[0]!.content[0], paragraph);
	assert.equal(createUpdateReferenceCommand(schema, model.document, 'empty', 'empty', ''), undefined);
	assert.equal(buildReferenceIndex(model.document).references[1]!.text, '');
	model.undoBlocks();
	assert.equal(model.document.content[0]!.content[0]!.attrs.key, 'old');
});

test("Reference deletion keeps remaining definitions and last deletion leaves unresolved citations through history and codec", () => {
	const schema = createAcademyDocumentSchema();
	const first = schema.createNode("reference", { attrs: { key: "first" }, content: [schema.createNode("paragraph", { content: [schema.createText("First")] })] });
	const last = schema.createNode("reference", { attrs: { key: "last" }, content: [schema.createNode("paragraph", { content: [schema.createText("Last")] })] });
	const bibliography = schema.createNode("bibliography", { content: [first, last] });
	const paragraph = schema.createNode("paragraph", { content: [schema.createNode("citation", { attrs: { key: "first", label: "[First]" } }), schema.createNode("citation", { attrs: { key: "last" } })] });
	const document = schema.createDocument([bibliography, paragraph]);
	using model = DocumentTextModel.create(schema, document, { plugins: [createReferenceIndexPlugin()] });
	const deletion = createDeleteReferenceCommand(schema, model.document, " first ");
	assert.ok(deletion);
	assert.ok(model.dispatch(deletion.transaction));
	assert.deepEqual(model.document.content[0], { ...bibliography, content: [last] });
	assert.deepEqual(model.document.content[1], paragraph);
	assert.deepEqual(model.getPluginState(REFERENCE_INDEX_KEY)?.unresolvedKeys, ["first"]);
	const beforeLast = model.document;
	const deleteLast = createDeleteReferenceCommand(schema, beforeLast, " last ");
	assert.ok(deleteLast);
	const decoded = deserializeDocumentTransaction(serializeDocumentTransaction(deleteLast.transaction, schema), schema);
	assert.ok(model.dispatch(decoded));
	assert.deepEqual(model.document.content, [paragraph]);
	assert.deepEqual(model.getPluginState(REFERENCE_INDEX_KEY)?.unresolvedKeys, ["first", "last"]);
	assert.deepEqual(deserializeDocument(serializeDocument(model.document, schema), schema), model.document);
	assert.ok(model.undoBlocks());
	assert.deepEqual(model.document, beforeLast);
	assert.ok(model.undoBlocks());
	assert.deepEqual(model.document, document);
	assert.ok(model.redoBlocks());
	assert.deepEqual(model.document, beforeLast);
	assert.ok(model.redoBlocks());
	assert.deepEqual(model.document.content, [paragraph]);
});

test('References reuse a bibliography inside a section and last deletion keeps its owner editable', () => {
	const schema = createAcademyDocumentSchema();
	for (const inSection of [false, true]) {
		const reference = schema.createNode('reference', { attrs: { key: 'one' }, content: [schema.createNode('paragraph')] });
		const bibliography = schema.createNode('bibliography', { content: [reference] });
		const document = schema.createDocument([inSection ? schema.createNode('documentSection', { content: [bibliography] }) : bibliography]);
		using model = DocumentTextModel.create(schema, document);
		const append = createInsertReferenceCommand(schema, model.document, 'two', 'Second');
		assert.ok(append);
		model.dispatch(append.transaction);
		const index = buildReferenceIndex(model.document);
		assert.deepEqual(index.references.map(entry => entry.key), ['one', 'two']);
		assert.equal(model.document.content.length, 1);
		model.undoBlocks();
		const deletion = createDeleteReferenceCommand(schema, model.document, 'one');
		assert.ok(deletion);
		model.dispatch(deletion.transaction);
		const owner = inSection ? model.document.content[0]! : model.document;
		assert.equal(owner.content[0]!.type, 'paragraph');
		assert.equal(deletion.focus!.blockId, owner.content[0]!.id);
		schema.validate(model.document);
		model.undoBlocks();
		assert.deepEqual(model.document, document);
	}
});

test("TextModel handles insertion, attributes, movement, and deletion as one history unit", () => {
	const schema = createDefaultDocumentSchema();
	const document = createDocument(schema);
	const secondParagraph = schema.createNode("paragraph", {
		id: "paragraph-2",
		content: [schema.createText("Second", { id: "text-2" })],
	});
	using model = DocumentTextModel.create(schema, document);

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
	using model = DocumentTextModel.create(schema, createDocument(schema));
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
	assert.deepEqual(JSON.parse(encoded), { format: "ash.document", version: 2, documentType: "general", document });
	assert.throws(() => deserializeDocument("{\"format\":\"ash.document\",\"version\":99}", schema), DocumentSerializationError);
	assert.throws(() => deserializeDocument("not json", schema), DocumentSerializationError);
});

test("Document v2 rejects a conflicting kind even when both schemas accept the tree", () => {
	const general = createDefaultDocumentSchema();
	const academy = createAcademyDocumentSchema();
	for (const schema of [general, academy]) {
		const document = createDocument(schema);
		const encoded = serializeDocument(document, schema);
		assert.deepEqual(JSON.parse(encoded), { format: "ash.document", version: 2, documentType: schema.documentType, document });
		assert.deepEqual(deserializeDocument(encoded, schema), document);
		const other = schema === general ? academy : general;
		other.validate(document);
		assert.throws(() => deserializeDocument(encoded, other), /Structured document type/u);
		for (const documentType of [undefined, null, "unknown", 1, {}]) {
			assert.throws(() => deserializeDocument({ ...JSON.parse(encoded), documentType }, schema), DocumentSerializationError);
		}
	}
});

test("Legacy Academy documents upgrade on serialization without losing IDs, attributes or marks", () => {
	const schema = createAcademyDocumentSchema();
	const document = schema.createDocument([
		schema.createNode("paragraph", {
			id: "legacy-paragraph", attrs: { alignment: "center" },
			content: [schema.createText("Research", { id: "legacy-text", marks: [{ type: "strong", attrs: {} }] })],
		}),
	], "legacy-document");
	const legacy = { format: "ash.document", version: 1, document };
	const migrated = deserializeDocument(JSON.stringify(legacy), schema);
	assert.deepEqual(migrated, document);
	assert.ok(Object.isFrozen(migrated));
	assert.deepEqual(JSON.parse(serializeDocument(migrated, schema)), { ...legacy, version: 2, documentType: "academy" });
	assert.throws(() => deserializeDocument({ ...legacy, documentType: "general" }, schema), /Legacy/u);
	assert.throws(() => deserializeDocument({ ...legacy, document: { ...document, content: [{ type: "unknown" }] } }, schema), DocumentSerializationError);
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
	using model = DocumentTextModel.create(schema, createDocument(schema), { plugins: [plugin] });
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
	using model = DocumentTextModel.create(schema, schema.createDocument([targetParagraph], "target-document"), { selection });
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
	using model = DocumentTextModel.create(schema, schema.createDocument([target], "target-document"));
	const insert = createInsertFragmentCommand(schema, model.document, "target-paragraph", textSelection({ nodeId: "target-text", offset: 3 }), decoded);
	assert.ok(insert);
	model.dispatch(insert.transaction);
	assert.deepEqual(model.document.content[0]?.content.map(node => node.text ?? node.type), ["Tar", "A", "hardBreak", "B", "get"]);
	assert.notEqual(model.document.content[0]?.content[1]?.id, "source-text-1");
	assert.equal(model.document.content[0]?.content[1]?.marks[0]?.type, "strong");
	assert.throws(() => deserializeDocumentFragment("{\"format\":\"ash.document.fragment\",\"version\":1,\"content\":[{\"id\":\"bad\",\"type\":\"unknown\",\"attrs\":{},\"content\":[],\"marks\":[]}]}", schema), /fragment/);
});
