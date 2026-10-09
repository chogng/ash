import { URI } from '../../../base/common/uri.js';
import { Schemas } from '../../../base/common/network.js';
import type { ExtensionResourceRequest } from '../../extensions/common/extensionApi.js';
import { extensionResourceRequest, type IExtensionResourceLoaderService } from '../common/extensionResourceLoader.js';
import { localize } from '../../../nls.js';

interface GalleryResourceRequest {
	readonly resourceUrlTemplate: string;
	readonly publisher: string;
	readonly name: string;
	readonly version: string;
	readonly path: string;
}

interface GalleryResourceSource {
	template(): Promise<string | undefined>;
	read(request: GalleryResourceRequest): Promise<Uint8Array>;
}

/** The source callbacks bind one renderer's browser snapshot or backend connection; this service owns no transport. */
export class ExtensionResourceLoaderService implements IExtensionResourceLoaderService {
	constructor(
		private readonly readInstalled: (request: ExtensionResourceRequest) => Promise<Uint8Array>,
		private readonly gallery?: GalleryResourceSource,
	) { }

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
		const galleryRequest = await this.galleryRequest(resource as URI);
		if (!galleryRequest || !this.gallery) {
			throw new Error(localize('extensions.resources.unsupported', 'The resource is outside the configured extension gallery.'));
		}
		validatePath(galleryRequest.path);
		return this.gallery.read(galleryRequest);
	}

	public async supportsExtensionGalleryResources(): Promise<boolean> {
		return (await this.gallery?.template()) !== undefined;
	}

	public async isExtensionGalleryResource(uri: URI): Promise<boolean> {
		return (await this.galleryRequest(uri)) !== undefined;
	}

	public async getExtensionGalleryResourceURL(extension: { publisher: string; name: string; version: string; targetPlatform?: string; }, path = ''): Promise<URI | undefined> {
		if (extension.targetPlatform && !['universal', 'undefined', 'unknown'].includes(extension.targetPlatform)) {
			return undefined;
		}
		if (![extension.publisher, extension.name].every(value => /^[a-z\d_-]+$/iu.test(value)) || !/^\d+\.\d+\.\d+(?:[-+][a-z\d.+-]+)?$/iu.test(extension.version)) {
			throw new TypeError('Invalid extension gallery identity');
		}
		if (path) {
			validatePath(path);
		}
		const template = await this.gallery?.template();
		if (!template) {
			return undefined;
		}
		// URI encodes the path once, including package filenames with spaces or non-ASCII text.
		const uri = URI.parse(template);
		const resourcePath = uri.path
			.replace('{publisher}', extension.publisher)
			.replace('{name}', extension.name)
			.replace('{version}', extension.version)
			.replace('{path}', path);
		return uri.with({ path: resourcePath });
	}

	private async galleryRequest(uri: URI): Promise<GalleryResourceRequest | undefined> {
		if (uri.scheme !== Schemas.https || uri.query || uri.fragment) {
			return undefined;
		}
		const template = await this.gallery?.template();
		if (!template) {
			return undefined;
		}
		const base = URI.parse(template);
		if (base.scheme !== uri.scheme || base.authority !== uri.authority) {
			return undefined;
		}
		const pattern = base.path.split(/(\{publisher\}|\{name\}|\{version\}|\{path\})/u).map(part => {
			if (part === '{path}') {
				return '(.*)';
			}
			if (/^\{(?:publisher|name|version)\}$/u.test(part)) {
				return '([^/]+)';
			}
			return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
		}).join('');
		const match = new RegExp('^' + pattern + '$', 'u').exec(uri.path);
		if (!match) {
			return undefined;
		}
		return { resourceUrlTemplate: template, publisher: match[1], name: match[2], version: match[3], path: match[4] };
	}
}

function validatePath(path: string): void {
	if (!path || path.length > 1024 || /[\\:\0]/u.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
		throw new TypeError('Invalid extension resource path');
	}
}
