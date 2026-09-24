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

/** Frontend contract for managing and selecting host-owned named Remote connections. */
export interface IRemoteConnectionService {
	readonly available: boolean;
	list(): Promise<readonly RemoteConnectionDefinition[]>;
	save(connection: RemoteConnectionDefinition): Promise<RemoteConnectionDefinition>;
	update(originalName: string, connection: RemoteConnectionDefinition): Promise<RemoteConnectionDefinition>;
	remove(name: string): Promise<RemoteConnectionDefinition | undefined>;
	connect(name: string): Promise<void>;
}

export const IRemoteConnectionService = createServiceIdentifier<IRemoteConnectionService>("remoteConnectionService");

export const UnavailableRemoteConnectionService: IRemoteConnectionService = Object.freeze({
	available: false,
	list: () => Promise.resolve([]),
	save: () => Promise.reject(new Error("Named Remote connections require a native product host")),
	update: () => Promise.reject(new Error("Named Remote connections require a native product host")),
	remove: () => Promise.reject(new Error("Named Remote connections require a native product host")),
	connect: () => Promise.reject(new Error("Named Remote connections require a native product host")),
});
