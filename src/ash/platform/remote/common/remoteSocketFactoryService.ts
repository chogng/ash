import type { ISocket } from '../../../base/parts/ipc/common/ipc.net.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { CancellationError } from '../../../base/common/errors.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { RemoteConnection, RemoteConnectionOfType, RemoteConnectionType } from './remoteAuthorityResolver.js';

export interface IRemoteSocketFactoryService {
	readonly _serviceBrand: undefined;
	register<T extends RemoteConnectionType>(type: T, factory: ISocketFactory<T>): IDisposable;
	connect(connectTo: RemoteConnection, path: string, query: string, debugLabel: string): Promise<ISocket>;
}
export interface ISocketFactory<T extends RemoteConnectionType> {
	supports(connectTo: RemoteConnectionOfType<T>): boolean;
	connect(connectTo: RemoteConnectionOfType<T>, path: string, query: string, debugLabel: string): Promise<ISocket>;
}
export const IRemoteSocketFactoryService = createServiceIdentifier<IRemoteSocketFactoryService>('remoteSocketFactoryService');

interface FactoryEntry {
	readonly type: RemoteConnectionType;
	supports(connection: RemoteConnection): boolean;
	connect(connection: RemoteConnection, path: string, query: string, debugLabel: string): Promise<ISocket>;
}

/** Routes a connection to its registered carrier without interpreting the peer protocol. */
export class RemoteSocketFactoryService extends Disposable implements IRemoteSocketFactoryService {
	declare readonly _serviceBrand: undefined;
	private readonly factories = new Set<FactoryEntry>();
	constructor() {
		super();
		this._register(toDisposable(() => this.factories.clear()));
	}

	public register<T extends RemoteConnectionType>(type: T, factory: ISocketFactory<T>): IDisposable {
		this.assertNotDisposed();
		const entry: FactoryEntry = {
			type,
			supports: connection => factory.supports(connection as RemoteConnectionOfType<T>),
			connect: (connection, path, query, label) => factory.connect(connection as RemoteConnectionOfType<T>, path, query, label),
		};
		this.factories.add(entry);
		return toDisposable(() => this.factories.delete(entry));
	}

	public async connect(connectTo: RemoteConnection, path: string, query: string, debugLabel: string): Promise<ISocket> {
		this.assertNotDisposed();
		const entry = [...this.factories].find(candidate => candidate.type === connectTo.type && candidate.supports(connectTo));
		if (!entry) {
			throw new Error('No socket factory supports this Remote connection');
		}
		const socket = await entry.connect(connectTo, path, query, debugLabel);
		// A retired acquisition must not hand its late socket to the replacement connection.
		if (this.isDisposed || !this.factories.has(entry)) {
			socket.dispose();
			throw new CancellationError();
		}
		return socket;
	}
}
