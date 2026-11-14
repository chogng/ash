import { documentCodec, bindDocumentCodec } from '../../../../../../../extensions/academy/common/model/documentCodec.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { RoomOpenParams } from '../../../../../../../.build/protocol/typescript/index.js';
import type { RoomOpenResult } from '../../../../../../../.build/protocol/typescript/index.js';
import type { RoomPresenceParams } from '../../../../../../../.build/protocol/typescript/index.js';
import type { RoomPresenceReadParams } from '../../../../../../../.build/protocol/typescript/index.js';
import type { RoomPresenceSnapshot } from '../../../../../../../.build/protocol/typescript/index.js';
import type { RoomSubmitParams } from '../../../../../../../.build/protocol/typescript/index.js';
import type { RoomSubmitResult } from '../../../../../../../.build/protocol/typescript/index.js';
import type { RoomUpdate } from '../../../../../../../.build/protocol/typescript/index.js';
import type { ServerNotification } from '../../../../../../../.build/protocol/typescript/index.js';
import { textSelection } from '../../../../../../../extensions/academy/common/core/documentSelection.js';
import type { DocumentNode } from '../../../../../../../extensions/academy/common/model/document.js';
import { createDefaultDocumentSchema, type DocumentSchema } from '../../../../../../../extensions/academy/common/model/documentSchema.js';
import { applyDocumentTransaction, DocumentTransaction } from '../../../../../../../extensions/academy/common/model/documentTransaction.js';
import { serializeDocumentTransaction } from '../../../../../../../extensions/academy/common/model/documentTransactionSerialization.js';
import type { RemoteRoomEnvelope } from '../../common/collabService.js';
import type { IServerEventApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import type { ICollabApi } from '../../../../../platform/collab/common/collabApi.js';
import { AppServerCollabService } from '../../browser/appServerCollabService.js';

test('Stanza App Server collaboration adapter uses JSON-safe ordered versions and delivers room updates', async () => {
	const schema = createDefaultDocumentSchema();
	const document = createDocument(schema);
	const events = new FakeServerEvents();
	const api = new FakeCollabApi();
	using service = new AppServerCollabService(api, events);
	using connection = await service.open({ codec: bindDocumentCodec(schema), clientId: 'client-a', schemaId: 'stanza-document-v1', document }, new AbortController().signal);

	assert.equal(connection.roomId, 'room-a');
	assert.equal(connection.canEdit, true);
	assert.equal(connection.canManageMembers, false);
	assert.equal(connection.principalId, undefined);
	await assert.rejects(connection.createInvite('Writer', 'editor', new AbortController().signal), /does not manage remote room members/);
	await assert.rejects(connection.listMembers(new AbortController().signal), /does not manage remote room members/);
	assert.equal(connection.initialSnapshot.version, 0);
	assert.equal(connection.currentPresence[0]?.clientId, 'client-c');
	const received: RemoteRoomEnvelope[] = [];
	connection.onDidReceiveUpdate(update => received.push(update));
	const remote = new DocumentTransaction().replaceText('text-1', 0, 0, 'R');
	events.fire({ roomId: 'room-a', clientId: 'client-b', sequence: 1, baseVersion: 0, version: 1, transaction: serializeDocumentTransaction(remote, schema) });
	assert.equal(received.length, 1);
	assert.equal(received[0]?.version, 1);
	assert.ok(received[0]?.transaction instanceof DocumentTransaction);
	assert.deepEqual(received[0].transaction.steps, remote.steps);

	const local = new DocumentTransaction().replaceText('text-1', 0, 0, 'A');
	const localDocument = applyDocumentTransaction(document, schema, local).document;
	const outcome = await connection.submit({ clientId: 'client-a', sequence: 1, baseVersion: 0, transaction: local }, localDocument, new AbortController().signal);
	assert.equal(api.submissions[0]?.sequence, 1);
	assert.equal(api.submissions[0]?.baseVersion, 0);
	assert.equal(outcome.kind, 'accepted');
	assert.equal(outcome.kind === 'accepted' ? outcome.update.version : -1, 1);

	const receivedPresence: string[] = [];
	connection.onDidReceivePresence(presences => receivedPresence.push(...presences.map(presence => presence.clientId)));
	await connection.updatePresence(textSelection({ nodeId: 'text-1', offset: 1 }), new AbortController().signal);
	assert.equal(api.presenceUpdates[0]?.clientId, 'client-a');
	events.firePresence({ roomId: 'room-a', generation: 1, presences: [{ clientId: 'client-b', selection: JSON.stringify(textSelection({ nodeId: 'text-1', offset: 0 }, { nodeId: 'text-1', offset: 1 })) }] });
	assert.deepEqual(receivedPresence, ['client-b']);
});

function createDocument(schema: DocumentSchema): DocumentNode {
	return schema.createDocument([schema.createNode('paragraph', { id: 'paragraph-1', content: [schema.createText('Hello', { id: 'text-1' })] })], 'document-1');
}

class FakeCollabApi implements ICollabApi {
	async readStatus(params: { roomId: string; clientId: string; }) { return { roomId: params.roomId, epoch: "epoch-test", version: 0, canEdit: true }; }
	readonly submissions: RoomSubmitParams[] = [];
	readonly presenceUpdates: RoomPresenceParams[] = [];
	readonly initialPresence: RoomPresenceSnapshot = { roomId: 'room-a', generation: 0, presences: [{ clientId: 'client-c', selection: JSON.stringify(textSelection({ nodeId: 'text-1', offset: 0 })) }] };

	async open(params: RoomOpenParams): Promise<RoomOpenResult> {
		return { clientId: params.clientId, schemaId: params.schemaId, snapshot: { roomId: 'room-a', version: 0, document: params.document } };
	}

	async submit(params: RoomSubmitParams): Promise<RoomSubmitResult> {
		this.submissions.push(params);
		return {
			status: 'accepted',
			update: {
				roomId: params.roomId,
				clientId: params.clientId,
				sequence: params.sequence,
				baseVersion: params.baseVersion,
				version: params.baseVersion + 1,
				transaction: params.transaction,
			},
		};
	}

	async publishPresence(params: RoomPresenceParams): Promise<RoomPresenceSnapshot> {
		this.presenceUpdates.push(params);
		return { roomId: params.roomId, generation: this.presenceUpdates.length, presences: [] };
	}

	async readPresence(params: RoomPresenceReadParams): Promise<RoomPresenceSnapshot> {
		assert.equal(params.roomId, this.initialPresence.roomId);
		return this.initialPresence;
	}
}

class FakeServerEvents implements IServerEventApi {
	private readonly listeners = new Set<(event: ServerNotification) => void>();

	subscribe(listener: (event: ServerNotification) => void): { dispose(): void; } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	fire(update: RoomUpdate): void {
		const event: ServerNotification = { method: 'document/collaboration/update', params: update };
		for (const listener of this.listeners) listener(event);
	}

	firePresence(presence: RoomPresenceSnapshot): void {
		const event: ServerNotification = { method: 'document/collaboration/presence', params: presence };
		for (const listener of this.listeners) listener(event);
	}
}
