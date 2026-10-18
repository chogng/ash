import { URI } from "../../../base/common/uri.js";
import { Schemas } from '../../../base/common/network.js';
import { getRemoteAuthority as getResourceRemoteAuthority } from './remoteHosts.js';

export const ASH_REMOTE_SCHEME = Schemas.ashRemote;
/** First SSH initialization also verifies and installs the remote profile's runtime package. */
export const SSH_REMOTE_INITIALIZE_TIMEOUT_MS = 180_000;
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
	const encodedPath = remoteUriPath(normalizedPath).split("/").map(segment => encodeURIComponent(segment)).join("/");
	return URI.parse(`${ASH_REMOTE_SCHEME}://${authority.authority}${encodedPath}`);
}

/** Optional Session runtimes use an opaque authority; SessionDirectory owns execution routing. */
export function createProviderRemoteWorkspaceUri(providerId: string, workspace: string, path: string): URI {
	return URI.from({ scheme: ASH_REMOTE_SCHEME, authority: `provider+${encodeURIComponent(JSON.stringify([providerId, workspace]))}`, path: remoteUriPath(normalizeRemoteWorkspacePath(path)) });
}

/** Resolves the connection authority encoded by a Remote resource URI. */
export function getRemoteAuthority(resource: URI): RemoteAuthority | undefined {
	if (resource.scheme !== ASH_REMOTE_SCHEME) return undefined;
	if (!resource.authority.startsWith(SSH_AUTHORITY_PREFIX)) {
		throw new Error(`Unsupported Remote authority: ${resource.authority}`);
	}
	return createSshRemoteAuthority(resource.authority.slice(SSH_AUTHORITY_PREFIX.length));
}

/** Returns the remote OS folder path represented by a Remote resource URI. */
export function getRemoteWorkspacePath(resource: URI): string {
	const authority = getResourceRemoteAuthority(resource);
	if (!authority) throw new Error("Resource is not a Remote workspace URI");
	if (resource.query || resource.fragment) throw new Error("Remote workspace URI must not contain a query or fragment");
	const path = normalizeRemoteWorkspacePath(/^\/[a-zA-Z]:\//u.test(resource.path) ? resource.path.slice(1) : resource.path);
	// Provider-independent resource paths must also work for extension-resolved hosts.
	// SSH identities still pass through the stricter credential-free alias validator.
	const canonical = remoteResourceUri(authority, path);
	if (canonical.toString() !== resource.toString()) {
		throw new Error("Remote workspace URI must use its canonical resource identity");
	}
	return path;
}

/** Keeps the resource owner and canonical URI spelling when an adapter returns an OS path. */
export function withRemoteWorkspacePath(resource: URI, path: string): URI {
	const authority = getResourceRemoteAuthority(resource);
	if (!authority) throw new Error("Resource is not a Remote workspace URI");
	return remoteResourceUri(authority, normalizeRemoteWorkspacePath(path));
}

function remoteResourceUri(authority: string, path: string): URI {
	return authority.startsWith(SSH_AUTHORITY_PREFIX)
		? createSshRemoteWorkspaceUri(authority.slice(SSH_AUTHORITY_PREFIX.length), path)
		: URI.from({ scheme: ASH_REMOTE_SCHEME, authority, path: remoteUriPath(path) });
}

export function isRemoteResource(resource: URI): boolean {
	return resource.scheme === ASH_REMOTE_SCHEME;
}

/** Normalizes Windows separators while preserving literal POSIX backslashes. */
export function normalizeRemoteWorkspacePath(path: string): string {
	if (/[\x00-\x1f\x7f-\x9f]/u.test(path)) throw new Error("Remote workspace path contains control characters");
	if (isWindowsRemotePath(path)) {
		let normalized = path.replaceAll("\\", "/");
		const drive = /^[a-zA-Z]:/u.test(normalized);
		if (drive) normalized = normalized[0]!.toUpperCase() + normalized.slice(1);
		const rest = normalized.slice(drive ? 3 : 2);
		if ((drive && normalized[2] !== "/") || (!drive && rest.split("/").length < 2)) throw new Error("Remote workspace path must be absolute");
		if (!(drive && rest.length === 0) && rest.split("/").some(segment => !segment || /[. ]$/u.test(segment) || /[<>:"|?*]/u.test(segment) || /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])[ ]*(?:\.|$)/iu.test(segment))) throw new Error("Remote workspace path must be canonical");
		return normalized;
	}
	const normalized = path.trim();
	if (!normalized || !normalized.startsWith("/")) {
		throw new Error("Remote workspace path must be absolute");
	}
	const segments = normalized.split("/");
	if (normalized !== "/" && (normalized.endsWith("/") || segments.slice(1).some(segment => segment.length === 0 || segment === "." || segment === ".."))) {
		throw new Error("Remote workspace path must be canonical");
	}
	return normalized;
}

export function isWindowsRemotePath(path: string): boolean {
	return /^[a-zA-Z]:/u.test(path) || path.startsWith("//") || path.startsWith("\\\\");
}

function remoteUriPath(path: string): string {
	return /^[A-Z]:\//u.test(path) ? `/${path}` : path;
}
