import { URI } from '../../../base/common/uri.js';
import type { ExtensionResourceRequest } from '../../extensions/common/extensionApi.js';
import { extensionResourceRequest, type IExtensionResourceLoaderService } from '../common/extensionResourceLoader.js';
import { localize } from '../../../nls.js';

/** The source callbacks bind one renderer's browser snapshot or backend connection; this service owns no transport. */
export class ExtensionResourceLoaderService implements IExtensionResourceLoaderService {
	constructor(private readonly readInstalled: (request: ExtensionResourceRequest) => Promise<Uint8Array>) {}

	public async readExtensionResource(uri: URI): Promise<string> {
		return new TextDecoder('utf-8', { fatal: true }).decode(await this.readExtensionResourceBytes(uri));
	}

	public async readExtensionResourceBytes(resource: URI | ExtensionResourceRequest): Promise<Uint8Array> {
		const request = URI.isUri(resource) ? extensionResourceRequest(resource) : resource;
		if (request) {
			validatePath(request.path);
			if (!request.extensionId || !Number.isSafeInteger(request.generation) || request.generation < 0) {
				throw new TypeError('Invalid extension resource identity');
			}
			return this.readInstalled(request);
		}
		throw new Error(localize('extensions.resources.unsupported', 'The resource is not an installed extension resource.'));
	}
}

function validatePath(path: string): void {
	if (!path || path.length > 1024 || /[\\:\0]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
		throw new TypeError('Invalid extension resource path');
	}
}
