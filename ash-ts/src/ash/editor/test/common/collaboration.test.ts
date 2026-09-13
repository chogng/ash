import assert from "node:assert/strict";
import { test } from "mocha";
import { rebaseDocumentHistory, rebaseDocumentTransaction } from "../../contrib/collaboration/common/rebase.js";
import { TextModel } from "../../common/model/textModel.js";
import { TextModelRemoteHistoryPolicy } from "../../common/model/textModelBlockState.js";
import { createDefaultDocumentSchema, type DocumentSchema } from "../../common/model/documentSchema.js";
import { nodeSelection, textSelection } from "../../common/core/documentSelection.js";
import { DocumentTransaction } from "../../common/model/documentTransaction.js";

function createDocument(schema: DocumentSchema) {
	return schema.createDocument([
		schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("Hello", { id: "text-1" })] }),
		schema.createNode("paragraph", { id: "paragraph-2", content: [schema.createText("Second", { id: "text-2" })] }),
	], "document-1");
}

test("Stanza collaboration rebases text offsets and selections through remote insertion", () => {
	const schema = createDefaultDocumentSchema();
	const base = createDocument(schema);
	const local = new DocumentTransaction()
		.replaceText("text-1", 1, 1, "L")
		.withSelection(textSelection({ nodeId: "text-1", offset: 2 }));
	const remote = new DocumentTransaction().replaceText("text-1", 0, 0, "R");

	const result = rebaseDocumentTransaction(base, schema, local, remote);

	assert.equal(result.remoteDocument.content[0]?.content[0]?.text, "RHello");
	assert.equal(result.document.content[0]?.content[0]?.text, "RHLello");
	assert.deepEqual(result.transaction.steps, [{ kind: "replaceText", nodeId: "text-1", from: 2, to: 2, text: "L" }]);
	assert.deepEqual(result.transaction.selection, textSelection({ nodeId: "text-1", offset: 3 }));
	assert.deepEqual(result.droppedSteps, []);
});

test("Stanza collaboration shifts structural insertion indices through remote siblings", () => {
	const schema = createDefaultDocumentSchema();
	const base = createDocument(schema);
	const localNode = schema.createNode("paragraph", { id: "paragraph-local", content: [schema.createText("Local", { id: "text-local" })] });
	const remoteNode = schema.createNode("paragraph", { id: "paragraph-remote", content: [schema.createText("Remote", { id: "text-remote" })] });
	const local = new DocumentTransaction().insertNode("document-1", 1, localNode);
	const remote = new DocumentTransaction().insertNode("document-1", 0, remoteNode);

	const result = rebaseDocumentTransaction(base, schema, local, remote);

	assert.deepEqual(result.document.content.map(node => node.id), ["paragraph-remote", "paragraph-1", "paragraph-local", "paragraph-2"]);
	assert.equal(result.transaction.steps[0]?.kind, "insertNode");
	assert.equal(result.transaction.steps[0]?.kind === "insertNode" ? result.transaction.steps[0].index : -1, 2);
});

test("Stanza collaboration drops local steps whose targets were deleted remotely", () => {
	const schema = createDefaultDocumentSchema();
	const base = createDocument(schema);
	const local = new DocumentTransaction().setNodeAttributes("paragraph-2", { alignment: "center" });
	const remote = new DocumentTransaction().deleteNode("paragraph-2");

	const result = rebaseDocumentTransaction(base, schema, local, remote);

	assert.deepEqual(result.document.content.map(node => node.id), ["paragraph-1"]);
	assert.deepEqual(result.transaction.steps, []);
	assert.deepEqual(result.droppedSteps, local.steps);
});

test("Stanza collaboration preserves local transaction dependencies and local node selection", () => {
	const schema = createDefaultDocumentSchema();
	const base = createDocument(schema);
	const localNode = schema.createNode("paragraph", { id: "paragraph-local", content: [schema.createText("Local", { id: "text-local" })] });
	const local = new DocumentTransaction()
		.insertNode("document-1", 1, localNode)
		.setNodeAttributes("paragraph-local", { alignment: "center" })
		.withSelection(nodeSelection("paragraph-local"));
	const remote = new DocumentTransaction().insertNode("document-1", 0, schema.createNode("paragraph", { id: "paragraph-remote", content: [schema.createText("Remote", { id: "text-remote" })] }));

	const result = rebaseDocumentTransaction(base, schema, local, remote);

	assert.equal(result.document.content[2]?.attrs.alignment, "center");
	assert.deepEqual(result.transaction.selection, nodeSelection("paragraph-local"));
	assert.equal(result.transaction.steps.length, 2);
});

test("Stanza collaboration maps non-overlapping replacements after a remote replacement", () => {
	const schema = createDefaultDocumentSchema();
	const base = schema.createDocument([schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("Hello", { id: "text-1" })] })], "document-1");
	const local = new DocumentTransaction().replaceText("text-1", 2, 3, "X");
	const remote = new DocumentTransaction().replaceText("text-1", 0, 1, "Remote");

	const result = rebaseDocumentTransaction(base, schema, local, remote);

	assert.equal(result.document.content[0]?.content[0]?.text, "RemoteeXlo");
	assert.deepEqual(result.transaction.steps, [{ kind: "replaceText", nodeId: "text-1", from: 7, to: 8, text: "X" }]);
});

test("Stanza collaboration rebases both undo and redo branches without removing remote text", () => {
	const schema = createDefaultDocumentSchema();
	using model = TextModel.create(schema, createDocument(schema));
	model.dispatch(new DocumentTransaction().replaceText("text-1", 0, 0, "A"));
	model.dispatch(new DocumentTransaction().replaceText("text-1", 0, 0, "C"));
	assert.ok(model.undoBlocks());
	const remote = new DocumentTransaction().replaceText("text-1", 1, 1, "B");

	model.rebaseHistory(entries => rebaseDocumentHistory(model.document, schema, entries, remote));
	model.dispatchRemote(remote, TextModelRemoteHistoryPolicy.Preserve);
	assert.equal(model.document.content[0]?.content[0]?.text, "ABHello");

	assert.ok(model.undoBlocks());
	assert.equal(model.document.content[0]?.content[0]?.text, "BHello");
	assert.ok(model.redoBlocks());
	assert.equal(model.document.content[0]?.content[0]?.text, "ABHello");
	assert.ok(model.redoBlocks());
	assert.equal(model.document.content[0]?.content[0]?.text, "CABHello");
	assert.ok(model.undoBlocks());
	assert.equal(model.document.content[0]?.content[0]?.text, "ABHello");
	assert.ok(model.undoBlocks());
	assert.equal(model.document.content[0]?.content[0]?.text, "BHello");
});

test("Stanza collaboration replays structural history without moving an acknowledged remote block", () => {
	const schema = createDefaultDocumentSchema();
	const base = createDocument(schema);
	using model = TextModel.create(schema, base);
	const local = schema.createNode("paragraph", { id: "paragraph-local", content: [schema.createText("Local", { id: "text-local" })] });
	const remoteNode = schema.createNode("paragraph", { id: "paragraph-remote", content: [schema.createText("Remote", { id: "text-remote" })] });
	model.dispatch(new DocumentTransaction().insertNode("document-1", 1, local));
	const remote = new DocumentTransaction().insertNode("document-1", 2, remoteNode);

	model.rebaseHistory(entries => rebaseDocumentHistory(model.document, schema, entries, remote));
	model.dispatchRemote(remote, TextModelRemoteHistoryPolicy.Preserve);
	assert.deepEqual(model.document.content.map(node => node.id), ["paragraph-1", "paragraph-local", "paragraph-remote", "paragraph-2"]);

	assert.ok(model.undoBlocks());
	assert.deepEqual(model.document.content.map(node => node.id), ["paragraph-1", "paragraph-remote", "paragraph-2"]);
	assert.ok(model.redoBlocks());
	assert.deepEqual(model.document.content.map(node => node.id), ["paragraph-1", "paragraph-local", "paragraph-remote", "paragraph-2"]);
});

test("Stanza collaboration drops a history branch that would overwrite a remote replacement", () => {
	const schema = createDefaultDocumentSchema();
	using model = TextModel.create(schema, createDocument(schema));
	model.dispatch(new DocumentTransaction().replaceText("text-1", 0, 1, "A"));
	const remote = new DocumentTransaction().replaceText("text-1", 0, 1, "B");

	model.rebaseHistory(entries => rebaseDocumentHistory(model.document, schema, entries, remote));
	model.dispatchRemote(remote, TextModelRemoteHistoryPolicy.Preserve);
	assert.equal(model.document.content[0]?.content[0]?.text, "Bello");
	assert.equal(model.canUndoBlocks, false);
	assert.equal(model.canRedoBlocks, false);
});

test("Stanza collaboration drops structural history that would delete remote block content", () => {
	const schema = createDefaultDocumentSchema();
	using model = TextModel.create(schema, createDocument(schema));
	const local = schema.createNode("paragraph", { id: "paragraph-local", content: [schema.createText("Local", { id: "text-local" })] });
	model.dispatch(new DocumentTransaction().insertNode("document-1", 1, local));
	const remote = new DocumentTransaction().replaceText("text-local", 0, 5, "Remote");

	model.rebaseHistory(entries => rebaseDocumentHistory(model.document, schema, entries, remote));
	model.dispatchRemote(remote, TextModelRemoteHistoryPolicy.Preserve);
	assert.equal(model.document.content[1]?.content[0]?.text, "Remote");
	assert.equal(model.canUndoBlocks, false);
});
