import { encodeBase64, decodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { isRecord } from '../../../../../base/common/types.js';
import { localize } from '../../../../../nls.js';
import type { BufferCollabProfile } from '../../../../../workbench/services/collab/common/bufferCollabService.js';
import type { ArkdownRuntime } from './arkdownRuntime.js';

const maxSnapshotBytes = 4 * 1024 * 1024;
const maxUpdateBytes = 1024 * 1024;

/** Adapts Arkdown's buffer to the versioned Markdown room format. */
export function createArkdownCollabProfile(runtime: Pick<ArkdownRuntime, 'createBuffer'>): BufferCollabProfile {
	const encode = (update: Uint8Array): string => JSON.stringify({ format: 'ash.arkdown.crdt', version: 1, update: encodeBase64(VSBuffer.wrap(new Uint8Array(update))) });
	const envelopeBytes = encode(new Uint8Array()).length;
	const payloadBytes = (bytes: number): number => envelopeBytes + Math.ceil(bytes / 3) * 4;
	const serialize = (update: Uint8Array, limit: number): string => {
		const value = encode(update);
		if (value.length > limit) throw new TypeError('Markdown collaboration payload exceeds its limit');
		return value;
	};
	const deserialize = (input: unknown, limit: number): Uint8Array => {
		if (typeof input !== 'string' || input.length > limit) throw new TypeError('Invalid Markdown collaboration payload');
		const value: unknown = JSON.parse(input);
		if (!isRecord(value) || value.format !== 'ash.arkdown.crdt' || value.version !== 1 || typeof value.update !== 'string' || Object.keys(value).length !== 3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.update)) throw new TypeError('Invalid Markdown collaboration encoding');
		return decodeBase64(value.update).buffer;
	};
	return {
		schemaId: 'arkdown-markdown-v1',
		createBuffer: (client, source) => runtime.createBuffer(client, source),
		validateSizes(sizes): void {
			if (payloadBytes(sizes.snapshot_bytes) > maxSnapshotBytes || payloadBytes(sizes.update_bytes) > maxUpdateBytes) throw new Error(localize({ bundle: 'ash.arkdown', key: 'collabSizeLimit' }, 'This edit exceeds the collaboration size limit. Use a smaller edit.'));
		},
		codec: {
			serialize: update => serialize(update, maxSnapshotBytes),
			deserialize: input => deserialize(input, maxSnapshotBytes),
			serializeTransaction: update => serialize(update, maxUpdateBytes),
			deserializeTransaction: input => deserialize(input, maxUpdateBytes),
		},
	};
}
