import assert from "node:assert/strict";
import { test } from "mocha";
import { createDefaultDocumentSchema, type DocumentSchema } from "../../common/model/documentSchema.js";
import { textSelection } from "../../common/core/documentSelection.js";
import { DocumentTransaction } from "../../common/model/documentTransaction.js";
import { DocumentCollaborationSynchronizer, DocumentCollaborationError } from "../../contrib/collaboration/common/synchronizer.js";

function createDocument(schema: DocumentSchema) {
	return schema.createDocument([schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("Hello", { id: "text-1" })] })], "document-1");
}

test("Stanza collaboration synchronizer keeps canonical and optimistic snapshots separate", () => {
	const schema = createDefaultDocumentSchema();
	using synchronizer = new DocumentCollaborationSynchronizer({ schema, document: createDocument(schema), clientId: "client-a", version: 1 });
	const kinds: string[] = [];
	synchronizer.onDidChange(change => kinds.push(change.kind));

	const local = synchronizer.dispatchLocal(new DocumentTransaction().replaceText("text-1", 1, 1, "L"));
	assert.equal(local?.sequence, 1);
	assert.equal(local?.baseVersion, 1);
	assert.equal(synchronizer.canonicalDocument.content[0]?.content[0]?.text, "Hello");
	assert.equal(synchronizer.document.content[0]?.content[0]?.text, "HLello");
	assert.ok(synchronizer.pending);

	const remote = synchronizer.receiveRemote({
		clientId: "client-b",
		sequence: 4,
		baseVersion: 1,
		version: 2,
		transaction: new DocumentTransaction().replaceText("text-1", 0, 0, "R"),
	});
	assert.equal(remote.kind, "remote");
	assert.equal(remote.canonicalDocument.content[0]?.content[0]?.text, "RHello");
	assert.equal(remote.document.content[0]?.content[0]?.text, "RHLello");
	assert.equal(remote.pending?.steps[0]?.kind, "replaceText");
	assert.equal(remote.pending?.steps[0]?.kind === "replaceText" ? remote.pending.steps[0].from : -1, 2);
	assert.equal(synchronizer.version, 2);

	const retransmitted = synchronizer.takeNextSubmission();
	assert.equal(retransmitted?.sequence, 2);
	assert.equal(retransmitted?.baseVersion, 2);
	const acknowledgement = synchronizer.acknowledge({
		clientId: "client-a",
		sequence: 2,
		baseVersion: 2,
		version: 3,
		transaction: retransmitted!.transaction,
	});
	assert.equal(acknowledgement.kind, "acknowledged");
	assert.equal(synchronizer.document.content[0]?.content[0]?.text, "RHLello");
	assert.equal(synchronizer.canonicalDocument.content[0]?.content[0]?.text, "RHLello");
	assert.equal(synchronizer.pending, undefined);
	assert.equal(synchronizer.version, 3);
	assert.deepEqual(kinds, ["local", "remote", "local", "acknowledged"]);
});

test("Stanza collaboration synchronizer buffers typing while one ordered update is in flight", () => {
	const schema = createDefaultDocumentSchema();
	using synchronizer = new DocumentCollaborationSynchronizer({ schema, document: createDocument(schema), clientId: "client-a" });

	const first = synchronizer.dispatchLocal(new DocumentTransaction().replaceText("text-1", 0, 0, "A"));
	const second = synchronizer.dispatchLocal(new DocumentTransaction().replaceText("text-1", 1, 1, "B"));

	assert.equal(first?.sequence, 1);
	assert.equal(second, undefined);
	assert.equal(synchronizer.document.content[0]?.content[0]?.text, "ABHello");
	assert.equal(synchronizer.pendingSequence, 1);
	synchronizer.acknowledge({ clientId: "client-a", sequence: 1, baseVersion: 0, version: 1, transaction: first!.transaction });
	const next = synchronizer.takeNextSubmission();
	assert.equal(next?.sequence, 2);
	assert.equal(next?.baseVersion, 1);
	assert.equal(next?.transaction.steps.length, 1);
	assert.equal(synchronizer.document.content[0]?.content[0]?.text, "ABHello");
});

test("Stanza collaboration synchronizer rejects stale updates and local echoes", () => {
	const schema = createDefaultDocumentSchema();
	using synchronizer = new DocumentCollaborationSynchronizer({ schema, document: createDocument(schema), clientId: "client-a", version: 4 });

	assert.throws(() => synchronizer.receiveRemote({ clientId: "client-b", sequence: 1, baseVersion: 3, version: 5, transaction: new DocumentTransaction().replaceText("text-1", 0, 0, "R") }), DocumentCollaborationError);
	assert.throws(() => synchronizer.receiveRemote({ clientId: "client-a", sequence: 1, baseVersion: 4, version: 5, transaction: new DocumentTransaction().replaceText("text-1", 0, 0, "R") }), DocumentCollaborationError);
	assert.equal(synchronizer.dispatchLocal(new DocumentTransaction().withSelection(textSelection({ nodeId: "text-1", offset: 2 }))), undefined);
	assert.equal(synchronizer.document.content[0]?.content[0]?.text, "Hello");
});

test("Stanza collaboration synchronizer reports dropped pending steps after remote deletion", () => {
	const schema = createDefaultDocumentSchema();
	const document = schema.createDocument([
		schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("One", { id: "text-1" })] }),
		schema.createNode("paragraph", { id: "paragraph-2", content: [schema.createText("Two", { id: "text-2" })] }),
	], "document-1");
	using synchronizer = new DocumentCollaborationSynchronizer({ schema, document, clientId: "client-a" });
	synchronizer.dispatchLocal(new DocumentTransaction().setNodeAttributes("paragraph-2", { alignment: "center" }));

	const change = synchronizer.receiveRemote({ clientId: "client-b", sequence: 1, baseVersion: 0, version: 1, transaction: new DocumentTransaction().deleteNode("paragraph-2") });

	assert.equal(change.droppedSteps.length, 1);
	assert.equal(synchronizer.pending, undefined);
	assert.deepEqual(synchronizer.document.content.map(node => node.id), ["paragraph-1"]);
});
