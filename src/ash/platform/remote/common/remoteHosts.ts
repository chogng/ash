import { Schemas } from '../../../base/common/network.js';
import type { URI } from '../../../base/common/uri.js';

/** Reads a remote resource's authority without selecting its transport provider. */
export function getRemoteAuthority(uri: URI): string | undefined {
	return uri.scheme === Schemas.ashRemote ? uri.authority : undefined;
}
