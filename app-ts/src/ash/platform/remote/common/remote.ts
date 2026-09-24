import { URI } from "../../../base/common/uri.js";

export const ASH_REMOTE_SCHEME = "ash-remote";
const SSH_AUTHORITY_PREFIX = "ssh+";
const SSH_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;

/** Stable frontend view of a remote backend connection lifecycle. */
export type RemoteConnectionState = "disconnected" | "connecting" | "connected" | "disconnecting" | "reconnecting";

/** An SSH config host whose credentials remain owned by the native SSH client. */
export interface SshRemoteAuthority {
	readonly type: "ssh";
	readonly host: string;
	readonly authority: string;
}

export type RemoteAuthority = SshRemoteAuthority;

/** Creates a canonical Remote authority from one OpenSSH config host. */
export function createSshRemoteAuthority(host: string): SshRemoteAuthority {
	const normalizedHost = host.trim().toLowerCase();
	if (!SSH_HOST_PATTERN.test(normalizedHost)) {
		throw new Error("Remote SSH host must be a valid OpenSSH config host without credentials");
	}
	return Object.freeze({ type: "ssh", host: normalizedHost, authority: `${SSH_AUTHORITY_PREFIX}${normalizedHost}` });
}

/** Creates the resource identity for one absolute folder on an SSH host. */
export function createSshRemoteWorkspaceUri(host: string, path: string): URI {
	const authority = createSshRemoteAuthority(host);
	const normalizedPath = normalizeRemoteWorkspacePath(path);
	const encodedPath = normalizedPath.split("/").map(segment => encodeURIComponent(segment)).join("/");
	return URI.parse(`${ASH_REMOTE_SCHEME}://${authority.authority}${encodedPath}`);
}

/** Resolves the connection authority encoded by a Remote resource URI. */
export function getRemoteAuthority(resource: URI): RemoteAuthority | undefined {
	if (resource.scheme !== ASH_REMOTE_SCHEME) return undefined;
	if (!resource.authority.startsWith(SSH_AUTHORITY_PREFIX)) {
		throw new Error(`Unsupported Remote authority: ${resource.authority}`);
	}
	return createSshRemoteAuthority(resource.authority.slice(SSH_AUTHORITY_PREFIX.length));
}

/** Returns the absolute POSIX folder path represented by a Remote resource URI. */
export function getRemoteWorkspacePath(resource: URI): string {
	const authority = getRemoteAuthority(resource);
	if (!authority) throw new Error("Resource is not a Remote workspace URI");
	if (resource.query || resource.fragment) throw new Error("Remote workspace URI must not contain a query or fragment");
	const path = normalizeRemoteWorkspacePath(decodeURIComponent(resource.path));
	if (createSshRemoteWorkspaceUri(authority.host, path).toString() !== resource.toString()) {
		throw new Error("Remote workspace URI must use its canonical resource identity");
	}
	return path;
}

export function isRemoteResource(resource: URI): boolean {
	return resource.scheme === ASH_REMOTE_SCHEME;
}

function normalizeRemoteWorkspacePath(path: string): string {
	const normalized = path.trim();
	if (!normalized || !normalized.startsWith("/") || normalized.includes("\0")) {
		throw new Error("Remote workspace path must be an absolute POSIX path");
	}
	const segments = normalized.split("/");
	if (normalized !== "/" && (normalized.endsWith("/") || segments.slice(1).some(segment => segment.length === 0 || segment === "." || segment === ".."))) {
		throw new Error("Remote workspace path must be canonical");
	}
	return normalized;
}
