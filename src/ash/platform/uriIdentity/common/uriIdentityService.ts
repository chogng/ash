import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { posix } from '../../../base/common/path.js';
import { ExtUri, ResourcePathCasing } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { FileSystemProviderCapabilities, IFileService } from '../../files/common/files.js';
import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { IUriIdentityService } from './uriIdentity.js';

/** Owns canonical spelling; storage access and open-model lifetimes remain with their providers and consumers. */
export class UriIdentityService extends Disposable implements IUriIdentityService {
	declare readonly _serviceBrand: undefined;
	private readonly canonicalUris = new Map<string, URI>();
	public readonly extUri: ExtUri;

	constructor(@IFileService private readonly files: IFileService) {
		super();
		this.extUri = new ExtUri(uri => files.hasProvider(uri) && !files.hasCapability(uri, FileSystemProviderCapabilities.PathCaseSensitive) ? ResourcePathCasing.Insensitive : ResourcePathCasing.Sensitive);
		this._register(toDisposable(() => this.canonicalUris.clear()));
		const invalidate = ({ scheme }: { readonly scheme: string; }): void => {
			for (const [key, uri] of this.canonicalUris) {
				if (uri.scheme === scheme) this.canonicalUris.delete(key);
			}
		};
		this._register(files.onDidChangeFileSystemProviderRegistrations(invalidate));
		this._register(files.onDidChangeFileSystemProviderCapabilities(invalidate));
	}

	public asCanonicalUri(uri: URI): URI {
		this.assertNotDisposed();
		if (!this.files.hasProvider(uri)) return uri;
		// Normalize encoded segments so an escaped slash never becomes a path boundary.
		const encoded = uri.toEncodedComponents();
		const path = encoded.path ? posix.normalize(encoded.path) : encoded.path;
		const normalized = path === encoded.path ? uri : uri.withEncodedPath(path);
		const key = this.extUri.getComparisonKeyIgnoringFragment(normalized);
		const existing = this.canonicalUris.get(key);
		if (existing) {
			this.canonicalUris.delete(key);
			this.canonicalUris.set(key, existing);
			if (existing.toEncodedComponents().fragment === encoded.fragment) return existing;
			return URI.parse(existing.toString().split('#', 1)[0] + (encoded.fragment ? `#${encoded.fragment}` : ''));
		}
		this.canonicalUris.set(key, normalized);
		// Bound transient identities. Consumers must keep their own open resources alive independently of this cache.
		if (this.canonicalUris.size > 4096) this.canonicalUris.delete(this.canonicalUris.keys().next().value!);
		return normalized;
	}
}

registerSingleton(IUriIdentityService, UriIdentityService, InstantiationType.Delayed);
