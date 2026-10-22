import { createDefineParagraphStyleCommand } from '../../../../../extensions/academy/common/commands/documentParagraphCommands.js';
import { createReplaceDocumentMatchesCommand, findDocumentText } from '../../../../../extensions/academy/common/commands/documentFindCommands.js';
import { getDocumentParagraphStyles } from '../../../../../extensions/academy/common/model/documentParagraph.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { createDefaultDocumentSchema, type DocumentSchema } from "../../../../../extensions/academy/common/model/documentSchema.js";
import { textSelection } from "../../../../../extensions/academy/common/core/documentSelection.js";
import { DocumentTransaction } from "../../../../../extensions/academy/common/model/documentTransaction.js";
import { DocumentCollaborationSynchronizer, DocumentCollaborationError } from "../../../../../extensions/academy/common/contrib/collaboration/synchronizer.js";

function createDocument(schema: DocumentSchema) {
	return schema.createDocument([schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("Hello", { id: "text-1" })] })], "document-1");
}

for (const side of ['prefix', 'suffix'] as const) {
	test(`Academy find replacement across marks retains a concurrent ${side} edit through resubmission`, () => {
		const schema = createDefaultDocumentSchema();
		const document = schema.createDocument([schema.createNode('paragraph', {
			id: 'p', content: [
				schema.createText('before hello', { id: 'a' }),
				schema.createText('world after', { id: 'b', marks: [{ type: 'strong', attrs: {} }] }),
			]
		})]);
		using synchronizer = new DocumentCollaborationSynchronizer({ schema, document, clientId: 'local' });
		const matches = findDocumentText(document, 'helloworld', { matchCase: true, wholeWord: false });
		assert.equal(matches.length, 1);
		const command = createReplaceDocumentMatchesCommand(schema, document, matches, 'replacement');
		assert.ok(command);
		synchronizer.dispatchLocal(command.transaction);
		const remote = side === 'prefix' ? new DocumentTransaction().replaceText('a', 0, 6, 'PEER') : new DocumentTransaction().replaceText('b', 6, 11, 'PEER');
		synchronizer.receiveRemote({ clientId: 'peer', sequence: 1, baseVersion: 0, version: 1, transaction: remote });
		const submission = synchronizer.takeNextSubmission();
		assert.ok(submission);
		assert.equal(submission.baseVersion, 1);
		synchronizer.acknowledge({ ...submission, version: 2 });
		assert.equal(synchronizer.canonicalDocument.content[0]!.content.map(node => node.text).join(''), side === 'prefix' ? 'PEER replacement after' : 'before replacement PEER');
		assert.equal(synchronizer.pending, undefined);
	});
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

test('Academy concurrent style definitions keep independent identities and references during rebase', () => {
	const schema = createDefaultDocumentSchema();
	const document = schema.createDocument(['one', 'two'].map((value, i) => schema.createNode('paragraph', { id: `p${i}`, content: [schema.createText(value, { id: `t${i}` })] })));
	using synchronizer = new DocumentCollaborationSynchronizer({ schema, document, clientId: 'local' });
	const local = createDefineParagraphStyleCommand(document, 'p0', 'Local')!;
	const remote = createDefineParagraphStyleCommand(document, 'p1', 'Remote')!;
	synchronizer.dispatchLocal(local.transaction);
	synchronizer.receiveRemote({ clientId: 'remote', sequence: 1, baseVersion: 0, version: 1, transaction: remote.transaction });
	assert.deepEqual(getDocumentParagraphStyles(synchronizer.document).map(style => style.name).sort(), ['Local', 'Remote']);
	assert.notEqual(synchronizer.document.content[0]!.attrs.styleId, synchronizer.document.content[1]!.attrs.styleId);
	const submission = synchronizer.takeNextSubmission()!;
	synchronizer.acknowledge({ clientId: 'local', sequence: submission.sequence, baseVersion: submission.baseVersion, version: 2, transaction: submission.transaction });
	assert.deepEqual(synchronizer.document, synchronizer.canonicalDocument);
	assert.equal(synchronizer.pending, undefined);
});
