import { IExtensionHostApi, type ExtensionHostRuntime, type ExtensionHostRemoteAuthorityResolverRegistration, type JsonValue } from '../../../../platform/extensionHost/common/extensionHostApi.js';
import { ManagedRemoteConnection, WebSocketRemoteConnection, RemoteAuthorityResolverError, RemoteAuthorityResolverErrorCode, type ResolverResult, type ResolvedOptions } from '../../../../platform/remote/common/remoteAuthorityResolver.js';
import { isRecord } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';

/** Executes one resolver in an exact local extension incarnation; the fleet owns the process. */
export class ExtensionHostManager {
	constructor(private readonly runtime: ExtensionHostRuntime, @IExtensionHostApi private readonly api: IExtensionHostApi) { }

	public async resolveAuthority(remoteAuthority: string, resolveAttempt: number): Promise<ResolverResult> {
		const result = await this.invokeResolver(remoteAuthority, 'resolveAuthority', { authority: remoteAuthority, resolveAttempt });
		if (!isRecord(result)) { throw new TypeError('Invalid Remote authority result'); }
		if (isRecord(result.error)) {
			const error = result.error;
			if (!Object.values(RemoteAuthorityResolverErrorCode).includes(error.code as RemoteAuthorityResolverErrorCode) || typeof error.message !== 'string' || error.message.length > 4096 || typeof error.handled !== 'boolean') { throw new TypeError('Invalid Remote authority error'); }
			throw new RemoteAuthorityResolverError(error.message, error.code as RemoteAuthorityResolverErrorCode, error.handled);
		}
		const token = result.connectionToken;
		if (token !== null && (typeof token !== 'string' || token.length > 8192 || /[\u0000-\u001f\u007f]/.test(token))) { throw new TypeError('Invalid Remote authority token'); }
		let connectTo;
		if (result.type === 'webSocket' && typeof result.host === 'string' && /^[a-zA-Z0-9._:-]{1,255}$/.test(result.host) && Number.isInteger(result.port) && (result.port as number) > 0 && (result.port as number) <= 65535) {
			connectTo = new WebSocketRemoteConnection(result.host, result.port as number);
		} else if (result.type === 'managed' && Number.isSafeInteger(result.id) && (result.id as number) > 0) {
			// Main's MessagePort acquisitions use positive IDs; extension factories use negative IDs.
			connectTo = new ManagedRemoteConnection(-(result.id as number));
		} else { throw new TypeError('Invalid Remote authority endpoint'); }
		const options = readResolvedOptions(result.options);
		return { authority: { authority: remoteAuthority, connectTo, connectionToken: token === null ? undefined : token as string }, ...(options === undefined ? {} : { options }) };
	}

	public async getCanonicalURI(remoteAuthority: string, uri: URI): Promise<URI | null> {
		const result = await this.invokeResolver(remoteAuthority, 'getCanonicalURI', {
			authority: remoteAuthority,
			uri: { scheme: uri.scheme, authority: uri.authority, path: uri.path, query: uri.query, fragment: uri.fragment, external: uri.toString() },
		});
		if (result === null) { return null; }
		if (!isRecord(result) || typeof result.external !== 'string' || result.external.length > 16384) { throw new TypeError('Invalid canonical URI result'); }
		const canonical = URI.parse(result.external, true);
		for (const key of ['scheme', 'authority', 'path', 'query', 'fragment'] as const) {
			if (canonical[key] !== result[key]) { throw new TypeError('Inconsistent canonical URI components'); }
		}
		return canonical;
	}

	private invokeResolver(remoteAuthority: string, operation: string, payload: JsonValue): Promise<JsonValue> {
		const registration = this.runtime.registrations.find((entry): entry is ExtensionHostRemoteAuthorityResolverRegistration => entry.kind === 'remoteAuthorityResolver' && remoteAuthority.startsWith(`${entry.authorityPrefix}+`));
		if (!registration || this.runtime.lifecycle !== 'ready' || this.runtime.incarnation === undefined) {
			throw new RemoteAuthorityResolverError('No local resolver is available', RemoteAuthorityResolverErrorCode.NoResolverFound);
		}
		return this.api.invoke({
			extensionId: this.runtime.id, activationGeneration: this.runtime.activationGeneration, incarnation: this.runtime.incarnation,
			registrationId: registration.registrationId, operation, payload, deadlineUnixMillis: Date.now() + 30_000,
		}, new AbortController().signal);
	}
}

function readResolvedOptions(value: JsonValue | undefined): ResolvedOptions | undefined {
	if (value === undefined) { return undefined; }
	if (!isRecord(value) || Object.keys(value).some(key => !['extensionHostEnv', 'isTrusted', 'authenticationSession'].includes(key))) { throw new TypeError('Invalid resolver options'); }
	const options: { extensionHostEnv?: Record<string, string | null>; isTrusted?: boolean; authenticationSession?: { id: string; providerId: string; }; } = {};
	if (value.isTrusted !== undefined) {
		if (typeof value.isTrusted !== 'boolean') { throw new TypeError('Invalid resolver trust option'); }
		options.isTrusted = value.isTrusted;
	}
	if (value.extensionHostEnv !== undefined) {
		const env = value.extensionHostEnv;
		if (!isRecord(env) || Object.keys(env).length > 128) { throw new TypeError('Invalid resolver environment'); }
		options.extensionHostEnv = {};
		for (const [key, entry] of Object.entries(env)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || (entry !== null && (typeof entry !== 'string' || entry.length > 8192 || entry.includes('\0')))) { throw new TypeError('Invalid resolver environment entry'); }
			Object.defineProperty(options.extensionHostEnv, key, { value: entry, enumerable: true });
		}
	}
	if (value.authenticationSession !== undefined) {
		const session = value.authenticationSession;
		if (!isRecord(session) || Object.keys(session).some(key => !['id', 'providerId'].includes(key)) || [session.id, session.providerId].some(entry => typeof entry !== 'string' || !entry || entry.length > 1024 || /[\u0000-\u001f\u007f]/.test(entry))) { throw new TypeError('Invalid resolver authentication session'); }
		options.authenticationSession = { id: session.id as string, providerId: session.providerId as string };
	}
	return options;
}
