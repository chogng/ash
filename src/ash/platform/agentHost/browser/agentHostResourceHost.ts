import { encodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { DisposableStore, type IDisposable } from '../../../base/common/lifecycle.js';
import { throwIfCancelled } from '../../../base/common/cancellation.js';
import type { IAgentHostResourceService } from '../common/agentHostResourceService.js';
import type { AppServerProtocolClient } from './appServerProtocolClient.js';
import { APP_SERVER_SERVER_REQUESTS } from '../../../../../.build/protocol/typescript/index.js';

/** Wire access is scoped by the client which owns these handlers, never by a caller-supplied host name. */
export function registerAgentHostResourceHost(
	client: AppServerProtocolClient,
	snapshots: IAgentHostResourceService,
): IDisposable {
	const lifetime = new DisposableStore();
	try {
		lifetime.add(
			client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['hostResource/read'], (params, context) => {
				throwIfCancelled(context.signal);
				const chunk = snapshots.read(params.handle, params.offset, params.maxBytes);
				return {
					handle: params.handle,
					offset: params.offset,
					dataBase64: encodeBase64(VSBuffer.wrap(Uint8Array.from(chunk.bytes))),
					decodedLength: chunk.bytes.byteLength,
					eof: chunk.eof,
				};
			}),
		);
		lifetime.add(
			client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['hostResource/release'], (params, context) => {
				throwIfCancelled(context.signal);
				snapshots.release(params.handle);
				return null;
			}),
		);
		lifetime.add(
			client.onStateChange(state => {
				if (state !== 'ready') {
					snapshots.connectionClosed();
				}
			}),
		);
		return lifetime;
	} catch (error) {
		lifetime.dispose();
		throw error;
	}
}
