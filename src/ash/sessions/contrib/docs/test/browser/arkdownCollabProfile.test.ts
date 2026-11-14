import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { CollabBuffer } from '../../../../../workbench/services/collab/common/bufferCollabService.js';
import { createArkdownCollabProfile } from '../../browser/arkdown/arkdownCollabProfile.js';

const profile = createArkdownCollabProfile({ createBuffer: () => { throw new Error('Unexpected buffer creation'); } });

test('Arkdown room profile preserves its wire identity and delegates buffer construction', () => {
	const buffer = {} as CollabBuffer;
	const calls: unknown[] = [];
	const value = createArkdownCollabProfile({ createBuffer: (client, source) => { calls.push([client, source]); return buffer; } });
	assert.equal(value.schemaId, 'arkdown-markdown-v1');
	assert.equal(value.createBuffer(7, 'Initial source'), buffer);
	assert.deepEqual(calls, [[7, 'Initial source']]);
	const update = new Uint8Array([0, 1, 253, 254, 255]);
	assert.equal(value.codec.serialize(update), '{"format":"ash.arkdown.crdt","version":1,"update":"AAH9/v8="}');
	assert.deepEqual(value.codec.deserialize(value.codec.serialize(update)), update);
	assert.deepEqual(value.codec.deserializeTransaction(value.codec.serializeTransaction(update)), update);
});

test('Arkdown room profile rejects malformed payloads at its codec boundary', () => {
	for (const input of [null, {}, '[]', '{', '{"format":"other","version":1,"update":""}', '{"format":"ash.arkdown.crdt","version":2,"update":""}', '{"format":"ash.arkdown.crdt","version":1,"update":"!"}', '{"format":"ash.arkdown.crdt","version":1,"update":"","extra":true}']) {
		assert.throws(() => profile.codec.deserialize(input));
		assert.throws(() => profile.codec.deserializeTransaction(input));
	}
});

test('Arkdown room profile enforces distinct snapshot and transaction limits on both directions', () => {
	const largeUpdate = new Uint8Array(800 * 1024);
	const snapshot = profile.codec.serialize(largeUpdate);
	assert.deepEqual(profile.codec.deserialize(snapshot), largeUpdate);
	assert.throws(() => profile.codec.serializeTransaction(largeUpdate), /limit/u);
	assert.throws(() => profile.codec.deserializeTransaction(snapshot), /payload/u);
	assert.throws(() => profile.codec.serialize(new Uint8Array(4 * 1024 * 1024)), /limit/u);
	profile.validateSizes({ snapshot_bytes: 1024, update_bytes: 512 });
	assert.throws(() => profile.validateSizes({ snapshot_bytes: 4 * 1024 * 1024, update_bytes: 0 }));
	assert.throws(() => profile.validateSizes({ snapshot_bytes: 0, update_bytes: 800 * 1024 }));
});
