import type { IExtUri } from '../../../base/common/resources.js';
import type { URI } from '../../../base/common/uri.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IUriIdentityService = createDecorator<IUriIdentityService>('uriIdentityService');

/** File-provider-aware URI identity shared by frontend resource owners. */
export interface IUriIdentityService {
	readonly _serviceBrand: undefined;
	readonly extUri: IExtUri;
	/** Keeps provider comparison facts for a model, editor or retained history lifetime. */
	retainUri(uri: URI): IDisposable;
	/** Establishes document identity, preserving query and the caller's fragment; not a display or authorization operation. */
	asCanonicalUri(uri: URI): URI;
	/** Prepares provider facts before establishing identity; cancellation releases only this caller's wait. */
	resolveCanonicalUri(uri: URI, signal?: AbortSignal): URI | Promise<URI>;
}
