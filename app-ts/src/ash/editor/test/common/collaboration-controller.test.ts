import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter, type Event } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import { TextModel } from "../../common/model/textModel.js";
import type { DocumentNode } from "../../common/model/document.js";
import { createDefaultDocumentSchema, type DocumentSchema } from "../../common/model/documentSchema.js";
import { DocumentTransaction } from "../../common/model/documentTransaction.js";
import { textSelection, type DocumentSelection } from "../../common/core/documentSelection.js";
import type { DocumentCollaborationConnection } from "../../common/services/documentCollaborationService.js";
import type { DocumentCollaborationSnapshot } from "../../common/services/documentCollaborationService.js";
import type { DocumentCollaborationPresence } from "../../common/services/documentCollaborationService.js";
import type { DocumentCollaborationSubmitOutcome } from "../../common/services/documentCollaborationService.js";
import { DocumentCollaborationController } from "../../contrib/collaboration/common/controller.js";
import type { DocumentCollaborationEnvelope } from "../../common/services/documentCollaborationService.js";
import type { DocumentCollaborationRemoteEnvelope } from "../../common/services/documentCollaborationService.js";

test("Stanza collaboration submits only the in-flight snapshot while later typing is buffered", async () => {
	const schema = createDefaultDocumentSchema();
	const document = createDocument(schema);
	using model = TextModel.create(schema, document);
	const connection = new FakeDocumentCollaborationConnection(schema, document);
	using controller = new DocumentCollaborationController(model, connection);

	model.dispatch(new DocumentTransaction().replaceText("text-1", 0, 0, "A"));
	assert.equal(connection.submissions.length, 1);
	assert.equal(firstText(connection.submissions[0]!.document), "AHello");

	model.dispatch(new DocumentTransaction().replaceText("text-1", 1, 1, "B"));
	assert.equal(firstText(model.document), "ABHello");
	assert.equal(connection.submissions.length, 1);

	connection.accept(0, 1);
	await flushMicrotasks();
	assert.equal(connection.submissions.length, 2);
	assert.equal(connection.submissions[1]!.envelope.sequence, 2);
	assert.equal(connection.submissions[1]!.envelope.baseVersion, 1);
	assert.equal(firstText(connection.submissions[1]!.document), "ABHello");

	connection.accept(1, 2);
	await flushMicrotasks();
	assert.equal(firstText(model.document), "ABHello");
	assert.equal(controller.state, "connected");
});

test("Stanza collaboration shares an author's undo and redo as ordered transactions", async () => {
	const schema = createDefaultDocumentSchema();
	const document = createDocument(schema);
	using model = TextModel.create(schema, document);
	const connection = new FakeDocumentCollaborationConnection(schema, document);
	using controller = new DocumentCollaborationController(model, connection);

	model.dispatch(new DocumentTransaction().replaceText("text-1", 0, 0, "A"));
	connection.accept(0, 1);
	await flushMicrotasks();
	assert.equal(firstText(model.document), "AHello");

	assert.ok(model.undoBlocks());
	await flushMicrotasks();
	assert.equal(connection.submissions.length, 2);
	assert.equal(connection.submissions[1]?.envelope.baseVersion, 1);
	assert.equal(firstText(connection.submissions[1]!.document), "Hello");
	connection.accept(1, 2);
	await flushMicrotasks();

	assert.ok(model.redoBlocks());
	await flushMicrotasks();
	assert.equal(connection.submissions.length, 3);
	assert.equal(connection.submissions[2]?.envelope.baseVersion, 2);
	assert.equal(firstText(connection.submissions[2]!.document), "AHello");
	connection.accept(2, 3);
	await flushMicrotasks();
	assert.equal(controller.state, "connected");
});

test("Stanza collaboration preserves a local author's history through an acknowledged remote edit", async () => {
	const schema = createDefaultDocumentSchema();
	const document = createDocument(schema);
	using model = TextModel.create(schema, document);
	const connection = new FakeDocumentCollaborationConnection(schema, document);
	using controller = new DocumentCollaborationController(model, connection);

	model.dispatch(new DocumentTransaction().replaceText("text-1", 0, 0, "A"));
	connection.accept(0, 1);
	await flushMicrotasks();
	model.dispatch(new DocumentTransaction().replaceText("text-1", 0, 0, "C"));
	connection.accept(1, 2);
	await flushMicrotasks();

	connection.receiveRemote(new DocumentTransaction().replaceText("text-1", 1, 1, "B"), 3);
	assert.equal(firstText(model.document), "CBAHello");
	assert.equal(model.canUndoBlocks, true);

	assert.ok(model.undoBlocks());
	await flushMicrotasks();
	assert.equal(firstText(model.document), "BAHello");
	connection.accept(2, 4);
	await flushMicrotasks();

	assert.ok(model.undoBlocks());
	await flushMicrotasks();
	assert.equal(firstText(model.document), "BHello");
	connection.accept(3, 5);
	await flushMicrotasks();

	assert.ok(model.redoBlocks());
	await flushMicrotasks();
	assert.equal(firstText(model.document), "BAHello");
	connection.accept(4, 6);
	await flushMicrotasks();

	assert.ok(model.redoBlocks());
	await flushMicrotasks();
	assert.equal(firstText(model.document), "CBAHello");
	connection.accept(5, 7);
	await flushMicrotasks();
	assert.equal(controller.state, "connected");
});

test("Stanza collaboration preserves local history when a remote update rebases in-flight typing", async () => {
	const schema = createDefaultDocumentSchema();
	const document = createDocument(schema);
	using model = TextModel.create(schema, document);
	const connection = new FakeDocumentCollaborationConnection(schema, document);
	using controller = new DocumentCollaborationController(model, connection);

	model.dispatch(new DocumentTransaction().replaceText("text-1", 0, 0, "A"));
	connection.conflictWithRemote(0, new DocumentTransaction().replaceText("text-1", 1, 1, "B"), 1);
	await flushMicrotasks();
	assert.equal(firstText(model.document), "AHBello");
	assert.equal(connection.submissions.length, 2);
	assert.equal(connection.submissions[1]?.envelope.baseVersion, 1);
	assert.equal(firstText(connection.submissions[1]!.document), "AHBello");
	connection.accept(1, 2);
	await flushMicrotasks();

	assert.ok(model.undoBlocks());
	await flushMicrotasks();
	assert.equal(firstText(model.document), "HBello");
	connection.accept(2, 3);
	await flushMicrotasks();

	assert.ok(model.redoBlocks());
	await flushMicrotasks();
	assert.equal(firstText(model.document), "AHBello");
	connection.accept(3, 4);
	await flushMicrotasks();
	assert.equal(controller.state, "connected");
});

test("Stanza collaboration publishes local selections without versioning them and exposes remote selections", async () => {
	const schema = createDefaultDocumentSchema();
	const document = createDocument(schema);
	using model = TextModel.create(schema, document);
	const connection = new FakeDocumentCollaborationConnection(schema, document);
	using controller = new DocumentCollaborationController(model, connection);
	const received: (readonly { readonly clientId: string }[])[] = [];
	controller.onDidChangePresence(change => received.push(change.presences));

	const local = textSelection({ nodeId: "text-1", offset: 1 });
	model.setSelection(local);
	await flushMicrotasks();
	assert.deepEqual(connection.presenceUpdates.at(-1), local);
	connection.acceptPresence([{ clientId: "client-b", selection: textSelection({ nodeId: "text-1", offset: 0 }, { nodeId: "text-1", offset: 1 }) }]);
	assert.equal(received[0]?.[0]?.clientId, "client-b");
});

function createDocument(schema: DocumentSchema): DocumentNode {
	return schema.createDocument([schema.createNode("paragraph", { id: "paragraph-1", content: [schema.createText("Hello", { id: "text-1" })] })], "document-1");
}

function firstText(document: DocumentNode): string | undefined {
	return document.content[0]?.content[0]?.text;
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

class FakeDocumentCollaborationConnection extends Disposable implements DocumentCollaborationConnection {
	private readonly updateEmitter = this._register(new Emitter<DocumentCollaborationRemoteEnvelope>());
	private readonly snapshotEmitter = this._register(new Emitter<DocumentCollaborationSnapshot>());
	private readonly presenceEmitter = this._register(new Emitter<readonly DocumentCollaborationPresence[]>());
	private readonly failureEmitter = this._register(new Emitter<Error>());

	readonly roomId = "stanza-test-room";
	readonly clientId = "client-a";
	readonly canEdit = true;
	readonly initialSnapshot: DocumentCollaborationSnapshot;
	readonly currentPresence: readonly DocumentCollaborationPresence[] = [];
	readonly onDidReceiveUpdate: Event<DocumentCollaborationRemoteEnvelope> = this.updateEmitter.event;
	readonly onDidReceiveSnapshot: Event<DocumentCollaborationSnapshot> = this.snapshotEmitter.event;
	readonly onDidReceivePresence: Event<readonly DocumentCollaborationPresence[]> = this.presenceEmitter.event;
	readonly onDidFail: Event<Error> = this.failureEmitter.event;
	readonly submissions: Submission[] = [];
	readonly presenceUpdates: (DocumentSelection | undefined)[] = [];

	constructor(readonly schema: DocumentSchema, document: DocumentNode) {
		super();
		this.initialSnapshot = Object.freeze({ roomId: this.roomId, version: 0, document });
	}

	submit(envelope: DocumentCollaborationEnvelope, document: DocumentNode, _signal: AbortSignal): Promise<DocumentCollaborationSubmitOutcome> {
		const submission = new Submission(envelope, document);
		this.submissions.push(submission);
		return submission.promise;
	}

	updatePresence(selection: DocumentSelection | undefined): Promise<void> {
		this.presenceUpdates.push(selection);
		return Promise.resolve();
	}





	acceptPresence(presences: readonly DocumentCollaborationPresence[]): void {
		this.presenceEmitter.fire(presences);
	}

	accept(index: number, version: number): void {
		const submission = this.submissions[index];
		assert.ok(submission, `Expected collaboration submission ${index}`);
		submission.resolve({
			kind: "accepted",
			update: {
				clientId: this.clientId,
				sequence: submission.envelope.sequence,
				baseVersion: submission.envelope.baseVersion,
				version,
				transaction: submission.envelope.transaction,
			},
		});
	}

	receiveRemote(transaction: DocumentTransaction, version: number): void {
		this.updateEmitter.fire({ clientId: "client-b", sequence: version, baseVersion: version - 1, version, transaction });
	}

	conflictWithRemote(index: number, transaction: DocumentTransaction, version: number): void {
		const submission = this.submissions[index];
		assert.ok(submission, `Expected collaboration submission ${index}`);
		submission.resolve({ kind: "conflict", updates: [{ clientId: "client-b", sequence: version, baseVersion: version - 1, version, transaction }] });
	}
}

class Submission {
	private readonly deferred: Deferred<DocumentCollaborationSubmitOutcome>;

	readonly promise: Promise<DocumentCollaborationSubmitOutcome>;

	constructor(readonly envelope: DocumentCollaborationEnvelope, readonly document: DocumentNode) {
		this.deferred = new Deferred<DocumentCollaborationSubmitOutcome>();
		this.promise = this.deferred.promise;
	}

	resolve(value: DocumentCollaborationSubmitOutcome): void {
		this.deferred.resolve(value);
	}
}

class Deferred<T> {
	private _resolve: ((value: T) => void) | undefined;

	readonly promise = new Promise<T>(resolve => {
		this._resolve = resolve;
	});

	resolve(value: T): void {
		this._resolve?.(value);
	}
}
