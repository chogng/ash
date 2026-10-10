import { localize } from '../../../nls.js';
import { throwIfCancelled } from '../../../base/common/cancellation.js';
import { Disposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { createServiceIdentifier } from "../../instantiation/common/instantiation.js";
import { createSshRemoteAuthority } from "./remote.js";
import { createSshRemoteWorkspaceUri } from "./remote.js";
import { getRemoteWorkspacePath } from "./remote.js";

const CONNECTION_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/** One credential-free SSH target loaded from the shared Remote connection catalog. */
export interface RemoteConnectionDefinition {
	readonly name: string;
	readonly host: string;
	readonly workspace: string;
}

/** Canonicalizes a credential-free saved connection at the frontend trust boundary. */
export function canonicalRemoteConnectionDefinition(connection: RemoteConnectionDefinition): RemoteConnectionDefinition {
	const name = canonicalRemoteConnectionName(connection.name);
	const authority = createSshRemoteAuthority(connection.host);
	const workspace = getRemoteWorkspacePath(createSshRemoteWorkspaceUri(authority.host, connection.workspace));
	return Object.freeze({ name, host: authority.host, workspace });
}

/** Canonicalizes one shared Remote catalog identity. */
export function canonicalRemoteConnectionName(value: string): string {
	const normalized = value.trim().toLowerCase();
	if (!CONNECTION_NAME_PATTERN.test(normalized)) throw new Error("Remote connection name must contain 1-64 ASCII letters, digits, dots, underscores, or hyphens and must start and end with a letter or digit");
	return normalized;
}

/** Mechanical host API; catalog storage and connection execution remain with the backend. */
export interface IRemoteConnectionApi {
	readonly available: boolean;
	list(): Promise<readonly RemoteConnectionDefinition[]>;
	save(connection: RemoteConnectionDefinition): Promise<RemoteConnectionDefinition>;
	update(originalName: string, connection: RemoteConnectionDefinition): Promise<RemoteConnectionDefinition>;
	remove(name: string): Promise<RemoteConnectionDefinition | undefined>;
	/** An expected target pins confirmation to the catalog values observed by the caller. */
	connect(name: string, expectedConnection?: RemoteConnectionDefinition): Promise<void>;
}

export const IRemoteConnectionApi = createServiceIdentifier<IRemoteConnectionApi>('remoteConnectionApi');

/** Ash saved-target selection; this does not resolve a VS Code transport endpoint. */
export interface RemoteConnectionResolver {
	readonly authorityPrefix: string;
	resolve(authority: string, signal: AbortSignal): Promise<{ readonly connectionName: string; }>;
}

export interface RemoteConnectionResolverRegistration extends IDisposable {
	replace(resolvers: readonly RemoteConnectionResolver[]): void;
}

/** Owns window-local selectors over the host's shared saved connection catalog. */
export interface IRemoteConnectionService extends IRemoteConnectionApi {
	registerResolvers(resolvers: readonly RemoteConnectionResolver[]): RemoteConnectionResolverRegistration;
	resolveConnection(authority: string, signal: AbortSignal): Promise<RemoteConnectionDefinition>;
}

export const IRemoteConnectionService = createServiceIdentifier<IRemoteConnectionService>('remoteConnectionService');

export const UnavailableRemoteConnectionApi: IRemoteConnectionApi = Object.freeze({
	available: false,
	list: () => Promise.resolve([]),
	save: () => Promise.reject(new Error("Named Remote connections require a native product host")),
	update: () => Promise.reject(new Error("Named Remote connections require a native product host")),
	remove: () => Promise.reject(new Error("Named Remote connections require a native product host")),
	connect: () => Promise.reject(new Error("Named Remote connections require a native product host")),
});

/** Owns window-local resolver registrations; the host remains the saved connection owner. */
export class RemoteConnectionService extends Disposable implements IRemoteConnectionService {
	private readonly batches = new Set<readonly RemoteConnectionResolver[]>();
	private readonly pending = new Map<AbortController, RemoteConnectionResolver | undefined>();

	constructor(@IRemoteConnectionApi private readonly api: IRemoteConnectionApi) {
		super();
		this._register(toDisposable(() => {
			for (const controller of this.pending.keys()) { controller.abort(); }
			this.pending.clear();
			this.batches.clear();
		}));
	}

	public get available(): boolean { return this.api.available; }
	public list(): Promise<readonly RemoteConnectionDefinition[]> { return this.api.list(); }
	public save(connection: RemoteConnectionDefinition): Promise<RemoteConnectionDefinition> { return this.api.save(connection); }
	public update(originalName: string, connection: RemoteConnectionDefinition): Promise<RemoteConnectionDefinition> { return this.api.update(originalName, connection); }
	public remove(name: string): Promise<RemoteConnectionDefinition | undefined> { return this.api.remove(name); }
	public connect(name: string, expectedConnection?: RemoteConnectionDefinition): Promise<void> { return this.api.connect(name, expectedConnection); }

	public registerResolvers(resolvers: readonly RemoteConnectionResolver[]): RemoteConnectionResolverRegistration {
		this.assertNotDisposed();
		let batch: readonly RemoteConnectionResolver[] = [];
		let disposed = false;
		const replace = (next: readonly RemoteConnectionResolver[]): void => {
			this.assertNotDisposed();
			if (disposed) { throw new ReferenceError('Remote resolver registration is disposed'); }
			const prefixes = new Set([...this.batches].filter(candidate => candidate !== batch).flatMap(candidate => candidate.map(resolver => resolver.authorityPrefix)));
			for (const resolver of next) {
				const prefix = validateRemoteConnectionResolverPrefix(resolver.authorityPrefix);
				if (prefixes.has(prefix)) { throw new TypeError(`Remote authority prefix '${prefix}' already has a resolver`); }
				prefixes.add(prefix);
			}
			for (const [controller, resolver] of this.pending) {
				if (resolver && batch.includes(resolver) && !next.includes(resolver)) { controller.abort(); }
			}
			this.batches.delete(batch);
			batch = Object.freeze([...next]);
			this.batches.add(batch);
		};
		replace(resolvers);
		return Object.assign(toDisposable(() => {
			disposed = true;
			this.batches.delete(batch);
			for (const [controller, resolver] of this.pending) { if (resolver && batch.includes(resolver)) { controller.abort(); } }
		}), { replace });
	}

	public async resolveConnection(authority: string, signal: AbortSignal): Promise<RemoteConnectionDefinition> {
		this.assertNotDisposed();
		throwIfCancelled(signal);
		const prefix = getRemoteConnectionAuthorityPrefix(authority);
		const resolver = [...this.batches].flat().find(candidate => candidate.authorityPrefix === prefix);
		if (!resolver) { throw new Error(localize('remote.resolver.missing', "No Remote resolver for '{0}'", prefix)); }
		const controller = new AbortController();
		this.pending.set(controller, resolver);
		const cancel = (): void => controller.abort(signal.reason);
		signal.addEventListener('abort', cancel, { once: true });
		const combined = controller.signal;
		try {
			const result = await resolver.resolve(authority, combined);
			throwIfCancelled(combined);
			if (!result || typeof result.connectionName !== 'string' || Object.keys(result).join(',') !== 'connectionName') { throw new TypeError('Remote resolver must return one saved connection name'); }
			const name = canonicalRemoteConnectionName(result.connectionName);
			const connection = (await this.list()).find(candidate => candidate.name === name);
			throwIfCancelled(combined);
			if (!connection) { throw new Error(localize('remote.resolver.targetMissing', "Remote connection '{0}' no longer exists", name)); }
			return connection;
		} finally {
			// The caller's signal can outlive this invocation, so release its listener on every exit.
			signal.removeEventListener('abort', cancel);
			this.pending.delete(controller);
		}
	}
}

export function validateRemoteConnectionResolverPrefix(value: string): string {
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) { throw new TypeError('Invalid Remote authority prefix'); }
	return value;
}

function getRemoteConnectionAuthorityPrefix(authority: string): string {
	const separator = authority.indexOf('+');
	if (separator < 1 || separator === authority.length - 1 || authority.length > 2048 || /[\u0000-\u0020\u007f]/.test(authority)) { throw new TypeError('Invalid Remote connection authority'); }
	return validateRemoteConnectionResolverPrefix(authority.slice(0, separator));
}
