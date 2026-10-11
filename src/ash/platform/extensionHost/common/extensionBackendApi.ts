import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { JsonValue } from './extensionHostApi.js';

/** A package-admitted backend route; the client never receives the protocol connection. */
export interface IExtensionBackendApi {
	request(method: string, params: JsonValue, signal: AbortSignal): Promise<JsonValue>;
}

export const IExtensionBackendApi = createServiceIdentifier<IExtensionBackendApi>('extensionBackendApi');
