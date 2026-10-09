import { URI } from '../../../base/common/uri.js';
import type { ExtensionResourceRequest } from '../../extensions/common/extensionApi.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const IExtensionResourceLoaderService = createDecorator<IExtensionResourceLoaderService>('extensionResourceLoaderService');

export interface IExtensionResourceLoaderService {
	readExtensionResource(uri: URI): Promise<string>;
	readExtensionResourceBytes(resource: URI | ExtensionResourceRequest): Promise<Uint8Array>;
	supportsExtensionGalleryResources(): Promise<boolean>;
	isExtensionGalleryResource(uri: URI): Promise<boolean>;
	getExtensionGalleryResourceURL(extension: { publisher: string; name: string; version: string; targetPlatform?: string; }, path?: string): Promise<URI | undefined>;
}

const extensionResourceScheme = 'ash-extension-resource';

/** Carries the catalog generation through URI-based text consumers. */
export function toExtensionResourceURI(request: ExtensionResourceRequest): URI {
	return URI.from({ scheme: extensionResourceScheme, authority: request.extensionId, path: '/' + request.path, query: `generation=${request.generation}` });
}

export function extensionResourceRequest(uri: URI): ExtensionResourceRequest | undefined {
	if (uri.scheme !== extensionResourceScheme) {
		return undefined;
	}
	if (uri.fragment || !/^generation=(0|[1-9]\d*)$/u.test(uri.query)) {
		throw new TypeError('Invalid extension resource generation');
	}
	const generation = Number(uri.query.slice('generation='.length));
	if (!Number.isSafeInteger(generation)) {
		throw new TypeError('Invalid extension resource generation');
	}
	return { extensionId: uri.authority, generation, path: uri.path.slice(1) };
}
