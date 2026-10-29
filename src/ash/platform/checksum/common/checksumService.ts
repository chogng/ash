import type { URI, UriComponents } from '../../../base/common/uri.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IChecksumService = createDecorator<IChecksumService>('checksumService');

export interface IChecksumService {
	readonly _serviceBrand: undefined;
	checksum(resource: URI): Promise<string>;
}

/** Only Main chooses the installed files. Renderers cannot request arbitrary paths. */
export interface ApplicationChecksums {
	readonly isBuilt: boolean;
	readonly proof: readonly { readonly uri: UriComponents; readonly expected: string; readonly actual: string | null; }[];
}
