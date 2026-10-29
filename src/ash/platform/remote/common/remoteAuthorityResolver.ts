import type { Event } from '../../../base/common/event.js';
import type { URI } from '../../../base/common/uri.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export const enum RemoteConnectionType {
	WebSocket,
	Managed,
}

export class ManagedRemoteConnection {
	public readonly type = RemoteConnectionType.Managed;
	constructor(public readonly id: number) { }
}

export class WebSocketRemoteConnection {
	public readonly type = RemoteConnectionType.WebSocket;
	constructor(public readonly host: string, public readonly port: number) { }
}

export type RemoteConnection = WebSocketRemoteConnection | ManagedRemoteConnection;


export type RemoteConnectionOfType<T extends RemoteConnectionType> = RemoteConnection & { type: T; };

export interface ResolvedAuthority {
	readonly authority: string;
	readonly connectTo: RemoteConnection;
	readonly connectionToken: string | undefined;
}

export interface ResolvedOptions {
	readonly extensionHostEnv?: { [key: string]: string | null; };
	readonly isTrusted?: boolean;
	readonly authenticationSession?: { id: string; providerId: string; };
}

export interface ResolverResult {
	authority: ResolvedAuthority;
	options?: ResolvedOptions;
}

export interface IRemoteConnectionData {
	connectTo: RemoteConnection;
	connectionToken: string | undefined;
}

export enum RemoteAuthorityResolverErrorCode {
	Unknown = 'Unknown',
	NotAvailable = 'NotAvailable',
	TemporarilyNotAvailable = 'TemporarilyNotAvailable',
	NoResolverFound = 'NoResolverFound',
	InvalidAuthority = 'InvalidAuthority',
}

export class RemoteAuthorityResolverError extends Error {
	public readonly isHandled: boolean;

	constructor(public readonly _message?: string, public readonly _code = RemoteAuthorityResolverErrorCode.Unknown, public readonly _detail?: unknown) {
		super(_message);
		this.name = 'RemoteAuthorityResolverError';
		this.isHandled = _code === RemoteAuthorityResolverErrorCode.NotAvailable && _detail === true;
	}
}

/** The extension service supplies results; the platform owns their connection lifetime. */
export interface IRemoteAuthorityResolverService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeConnectionData: Event<void>;
	resolveAuthority(authority: string): Promise<ResolverResult>;
	getCanonicalURI(uri: URI): Promise<URI>;
	getConnectionData(authority: string): IRemoteConnectionData | null;
	_clearResolvedAuthority(authority: string): void;
	_setResolvedAuthority(resolvedAuthority: ResolvedAuthority, resolvedOptions?: ResolvedOptions): void;
	_setResolvedAuthorityError(authority: string, error: unknown): void;
	_setCanonicalURIProvider(provider: (uri: URI) => Promise<URI>): void;
}

export const IRemoteAuthorityResolverService = createServiceIdentifier<IRemoteAuthorityResolverService>('remoteAuthorityResolverService');

export function getRemoteAuthorityPrefix(remoteAuthority: string): string {
	const delimiter = remoteAuthority.indexOf('+');
	return delimiter < 0 ? remoteAuthority : remoteAuthority.slice(0, delimiter);
}
