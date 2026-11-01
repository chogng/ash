import { canonicalAgentHostConnection, isSSHAgentHost, type RemoteAgentHostConnection } from '../../agentHost/common/remoteAgentHostService.js';
import { localize } from '../../../nls.js';
import { raceCancellationError } from '../../../base/common/async.js';
import { canceled } from '../../../base/common/errors.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { REMOTE_AGENT_HOST_OPEN_CHANNEL, REMOTE_AGENT_HOST_CLOSE_CHANNEL } from '../common/remoteConnectionIpc.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import { nonEmptyString } from '../../ipc/electron-main/ipcValidation.js';
import { record } from '../../ipc/electron-main/ipcValidation.js';
import { REMOTE_CONNECTION_CONNECT_CHANNEL } from '../common/remoteConnectionIpc.js';
import { REMOTE_CONNECTION_LIST_CHANNEL } from '../common/remoteConnectionIpc.js';
import { REMOTE_CONNECTION_REMOVE_CHANNEL } from '../common/remoteConnectionIpc.js';
import { REMOTE_CONNECTION_SAVE_CHANNEL } from '../common/remoteConnectionIpc.js';
import { REMOTE_CONNECTION_UPDATE_CHANNEL } from '../common/remoteConnectionIpc.js';
import { canonicalRemoteConnectionDefinition } from '../common/remoteConnectionService.js';
import { canonicalRemoteConnectionName } from '../common/remoteConnectionService.js';
import type { IRemoteConnectionApi } from '../common/remoteConnectionService.js';
import type { RemoteConnectionDefinition } from '../common/remoteConnectionService.js';

const MAX_WORKSPACE_INPUT_BYTES = 1024 * 1024;

/** Trusted IPC routes for managing and selecting named targets without accepting SSH options. */
export function remoteConnectionIpcRoutes(service: IRemoteConnectionApi): readonly IpcRoute<unknown, unknown>[] {
	return [
		{
			channel: REMOTE_CONNECTION_LIST_CHANNEL,
			validate: emptyParams,
			invoke: () => service.list(),
		},
		{
			channel: REMOTE_CONNECTION_CONNECT_CHANNEL,
			validate: connectParams,
			invoke: params => {
				const request = params as { readonly name: string; readonly expectedConnection?: RemoteConnectionDefinition; };
				return service.connect(request.name, request.expectedConnection);
			},
		},
		{
			channel: REMOTE_CONNECTION_SAVE_CHANNEL,
			validate: saveParams,
			invoke: params => service.save((params as { readonly connection: RemoteConnectionDefinition; }).connection),
		},
		{
			channel: REMOTE_CONNECTION_UPDATE_CHANNEL,
			validate: updateParams,
			invoke: params => {
				const request = params as { readonly originalName: string; readonly connection: RemoteConnectionDefinition; };
				return service.update(request.originalName, request.connection);
			},
		},
		{
			channel: REMOTE_CONNECTION_REMOVE_CHANNEL,
			validate: namedParams,
			invoke: params => service.remove((params as { readonly name: string; }).name),
		},
	];
}

function emptyParams(value: unknown): undefined {
	if (value !== undefined) throw new Error('Remote connection list does not accept parameters');
	return undefined;
}

function namedParams(value: unknown): { readonly name: string; } {
	const params = record(value, ['name']);
	return { name: canonicalRemoteConnectionName(boundedString(params.name, 'name', 64)) };
}

function connectParams(value: unknown): { readonly name: string; readonly expectedConnection?: RemoteConnectionDefinition; } {
	const hasExpected = typeof value === 'object' && value !== null && Object.hasOwn(value, 'expectedConnection');
	const params = record(value, hasExpected ? ['name', 'expectedConnection'] : ['name']);
	const name = canonicalRemoteConnectionName(boundedString(params.name, 'name', 64));
	if (!hasExpected) return { name };
	const expectedConnection = connectionDefinition(params.expectedConnection);
	if (expectedConnection.name !== name) throw new Error('Remote confirmation must refer to the same saved target');
	return { name, expectedConnection };
}

function saveParams(value: unknown): { readonly connection: RemoteConnectionDefinition; } {
	const params = record(value, ['connection']);
	return { connection: connectionDefinition(params.connection) };
}

function updateParams(value: unknown): { readonly originalName: string; readonly connection: RemoteConnectionDefinition; } {
	const params = record(value, ['originalName', 'connection']);
	return {
		originalName: canonicalRemoteConnectionName(boundedString(params.originalName, 'originalName', 64)),
		connection: connectionDefinition(params.connection),
	};
}

function connectionDefinition(value: unknown): RemoteConnectionDefinition {
	const connection = record(value, ['name', 'host', 'workspace']);
	return canonicalRemoteConnectionDefinition({
		name: boundedString(connection.name, 'connection.name', 64),
		host: boundedString(connection.host, 'connection.host', 253),
		workspace: boundedString(connection.workspace, 'connection.workspace', MAX_WORKSPACE_INPUT_BYTES),
	});
}

function boundedString(value: unknown, field: string, maximumBytes: number): string {
	const string = nonEmptyString(value, field);
	if (VSBuffer.fromString(string).byteLength > maximumBytes) throw new Error(`${field} exceeds its maximum encoded length`);
	return string;
}

/** Owns only this renderer document's carrier leases; the shared catalog remains backend-owned. */
export class RemoteAgentHostConnectionPool extends Disposable {
	private readonly leases = new Map<string, DisposableStore>();

	constructor(
		private readonly catalog: Pick<IRemoteConnectionApi, 'list'>,
		private readonly createConnection: (connection: RemoteAgentHostConnection, id: string, signal: AbortSignal, ticket?: string) => (IDisposable & { readonly connection?: RemoteAgentHostConnection; }) | Promise<IDisposable & { readonly connection?: RemoteAgentHostConnection; }>,
	) {
		super();
		this._register(toDisposable(() => this.reset()));
	}

	public routes(): readonly IpcRoute<unknown, unknown>[] {
		return [{
			channel: REMOTE_AGENT_HOST_OPEN_CHANNEL,
			validate: value => {
				const hasTicket = typeof value === 'object' && value !== null && Object.hasOwn(value, 'ticket');
				const params = record(value, hasTicket ? ['id', 'connection', 'ticket'] : ['id', 'connection']);
				const connection = canonicalAgentHostConnection(params.connection);
				if (hasTicket && (isSSHAgentHost(connection) || connection.type !== 'tunnel' || typeof params.ticket !== 'string' || !/^[a-f0-9]{64}$/.test(params.ticket))) throw new TypeError('Invalid Tunnel ticket');
				return { id: connectionLeaseId(params.id), connection, ...(hasTicket ? { ticket: params.ticket as string } : {}) };
			},
			invoke: value => {
				const request = value as { readonly id: string; readonly connection: RemoteAgentHostConnection; readonly ticket?: string; };
				return this.open(request.id, request.connection, request.ticket);
			},
		}, {
			channel: REMOTE_AGENT_HOST_CLOSE_CHANNEL,
			validate: value => connectionLeaseId(record(value, ['id']).id),
			invoke: value => this.close(value as string),
		}];
	}

	private async open(id: string, expected: RemoteAgentHostConnection, ticket?: string): Promise<RemoteAgentHostConnection> {
		this.assertNotDisposed();
		if (this.leases.has(id)) { throw new Error(localize({ bundle: 'ash.workbench', key: 'agentHosts.duplicateLease' }, 'Agent host connection lease already exists')); }
		if (this.leases.size >= 16) { throw new Error(localize({ bundle: 'ash.workbench', key: 'agentHosts.limit' }, 'Too many Agent host connections')); }
		const resources = new DisposableStore();
		const cancellation = new AbortController();
		resources.add(toDisposable(() => cancellation.abort()));
		// Register before the asynchronous catalog read so close/navigation retires setup too.
		this.leases.set(id, resources);
		try {
			if (isSSHAgentHost(expected)) {
				const actual = (await raceCancellationError(this.catalog.list(), cancellation.signal)).find(connection => connection.name === expected.name);
				if (!actual || actual.host !== expected.host || actual.workspace !== expected.workspace) {
					throw new Error(localize({ bundle: 'ash.workbench', key: 'agentHosts.targetChanged' }, 'Saved Remote connection changed; select the target again'));
				}
			}
			if (resources.isDisposed) throw canceled();
			const acquisition = Promise.resolve(this.createConnection(expected, id, cancellation.signal, ticket));
			void acquisition.then(lease => { if (resources.isDisposed) lease.dispose(); }, () => { });
			const lease = await raceCancellationError(acquisition, cancellation.signal);
			if (resources.isDisposed) { lease.dispose(); throw canceled(); }
			resources.add(lease);
			return lease.connection ?? expected;
		} catch (error) {
			if (this.leases.get(id) === resources) { this.close(id); }
			throw error;
		}
	}

	private close(id: string): void {
		const resources = this.leases.get(id);
		this.leases.delete(id);
		resources?.dispose();
	}

	/** A new document cannot acquire or release a predecessor's carriers. */
	public reset(): void {
		for (const id of this.leases.keys()) { this.close(id); }
	}
}

function connectionLeaseId(value: unknown): string {
	if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
		throw new TypeError('Invalid Agent host connection lease');
	}
	return value;
}
