import type { RemoteConnection } from './remoteAuthorityResolver.js';

export interface IAddress<T extends RemoteConnection = RemoteConnection> {
	connectTo: T;
	connectionToken: string | undefined;
}

export interface IAddressProvider<T extends RemoteConnection = RemoteConnection> {
	getAddress(): Promise<IAddress<T>>;
}
