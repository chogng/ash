import { CharCode } from './charCode.js';
import { MarshalledId } from './marshallingIds.js';
import * as paths from './path.js';
import { isWindows } from './platform.js';

const URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/** URI components are decoded; `toString()` retains their encoded spelling. */
export interface UriComponents {
	readonly scheme: string;
	readonly authority?: string;
	readonly path?: string;
	readonly query?: string;
	readonly fragment?: string;
}

interface UriState extends UriComponents {
	readonly $mid: MarshalledId.Uri;
	readonly external: string;
}

function encodePath(path: string): string {
	return encodeURI(path).replaceAll('?', '%3F').replaceAll('#', '%23');
}

function encodeQuery(query: string): string {
	return encodeURI(query).replaceAll('#', '%23');
}

function encodeFragment(fragment: string): string {
	return encodeURI(fragment).replaceAll('#', '%23');
}

export function isUriComponents(value: unknown): value is UriComponents {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as UriComponents;
	return typeof candidate.scheme === 'string'
		&& (candidate.authority === undefined || typeof candidate.authority === 'string')
		&& (candidate.path === undefined || typeof candidate.path === 'string')
		&& (candidate.query === undefined || typeof candidate.query === 'string')
		&& (candidate.fragment === undefined || typeof candidate.fragment === 'string');
}

function parseUrl(value: string): URL {
	if (!URI_SCHEME.test(value)) {
		throw new TypeError(`URI scheme is missing: ${value}`);
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch (error) {
		throw new TypeError(`Invalid URI: ${value}`, { cause: error });
	}

	if (url.username || url.password) {
		throw new TypeError("Resource URIs must not contain credentials");
	}
	if (!url.host && url.pathname.startsWith('//')) {
		throw new TypeError('URI path without an authority must not start with //');
	}

	validatePercentEncoding(url.pathname, "path");
	validatePercentEncoding(url.search, "query");
	validatePercentEncoding(url.hash, "fragment");
	return url;
}

function validatePercentEncoding(value: string, component: string): void {
	try {
		decodeURIComponent(value);
	} catch (error) {
		throw new TypeError(`URI ${component} has invalid percent encoding`, {
			cause: error,
		});
	}
}

/**
 * An immutable absolute resource URI.
 *
 * Component accessors return decoded values. The encoded spelling remains
 * available through `toString()` for resource identity and transport.
 */
export class URI {
	private value: URL | string;

	private constructor(value: URL | string) {
		this.value = value;
	}

	private get url(): URL {
		if (typeof this.value === 'string') this.value = new URL(this.value);
		return this.value;
	}

	static isUri(value: unknown): value is URI {
		if (value instanceof URI) return true;
		if (!value || typeof value !== 'object') return false;
		const candidate = value as Partial<URI>;
		return typeof candidate.scheme === 'string'
			&& typeof candidate.authority === 'string'
			&& typeof candidate.path === 'string'
			&& typeof candidate.query === 'string'
			&& typeof candidate.fragment === 'string'
			&& typeof candidate.fsPath === 'string'
			&& typeof candidate.with === 'function'
			&& typeof candidate.toString === 'function';
	}

	/** Parses a URI; non-strict mode assigns the file scheme when it is missing. */
	static parse(value: string, strict = false): URI {
		if (!URI_SCHEME.test(value)) {
			if (strict) throw new TypeError(`URI scheme is missing: ${value}`);
			return new URI(parseUrl(new URL(value, 'file:///').href));
		}
		return new URI(parseUrl(value));
	}

	/**
	 * Creates a `file:` URI from an absolute filesystem path using the current OS separator rules.
	 */
	static file(path: string): URI {
		if (path.length === 0) {
			throw new TypeError("File path must not be empty");
		}

		const normalized = isWindows ? path.replaceAll("\\", "/") : path;
		if (normalized.startsWith("//")) {
			const withoutPrefix = normalized.replace(/^\/+/, "");
			const separator = withoutPrefix.indexOf("/");
			const authority = separator < 0
				? withoutPrefix
				: withoutPrefix.slice(0, separator);
			const resourcePath = separator < 0 ? "/" : withoutPrefix.slice(separator);
			if (!authority) {
				throw new TypeError(`UNC path must contain a host: ${path}`);
			}
			const url = new URL(`file://${authority}/`);
			url.pathname = encodePath(resourcePath);
			return new URI(url);
		}

		if (!normalized.startsWith("/") && !WINDOWS_DRIVE_PATH.test(path)) {
			throw new TypeError(`File path must be absolute: ${path}`);
		}

		const resourcePath = WINDOWS_DRIVE_PATH.test(path)
			? `/${normalized}`
			: normalized;
		const url = new URL("file:///");
		url.pathname = encodePath(resourcePath);
		return new URI(url);
	}

	get scheme(): string {
		return this.url.protocol.slice(0, -1).toLowerCase();
	}

	get authority(): string {
		return this.url.host;
	}

	get path(): string {
		return decodeURIComponent(this.url.pathname);
	}

	get query(): string {
		return decodeURIComponent(this.url.search.slice(1));
	}

	get fragment(): string {
		return decodeURIComponent(this.url.hash.slice(1));
	}

	/** Encoded components used when the original URI spelling determines identity. */
	toEncodedComponents(): Required<UriComponents> {
		return {
			scheme: this.scheme,
			authority: this.authority,
			path: this.url.pathname,
			query: this.url.search.slice(1),
			fragment: this.url.hash.slice(1),
		};
	}

	/**
	 * Returns the decoded native path represented by a `file:` URI.
	 */
	get fsPath(): string {
		if (this.scheme !== "file") {
			throw new TypeError(`URI scheme is not file: ${this.scheme}`);
		}
		return uriToFsPath(this);
	}

	/** Creates a URI from decoded components. */
	static from(components: UriComponents, strict = false): URI {
		if (components.authority && components.path && !components.path.startsWith("/")) {
			throw new TypeError("URI paths with an authority must start with /");
		}
		if (!components.authority && components.path?.startsWith('//')) {
			throw new TypeError('URI path without an authority must not start with //');
		}
		if (strict && !components.scheme) throw new TypeError('URI scheme is missing');
		const scheme = components.scheme || 'file';
		const path = (scheme === 'file' && !components.path?.startsWith('/')) ? `/${components.path ?? ''}` : components.path ?? '';
		let value = `${scheme}:`;
		if (components.authority || scheme === "file") {
			value += `//${components.authority ?? ""}`;
		}
		value += encodePath(path);
		if (components.query) {
			value += `?${encodeQuery(components.query)}`;
		}
		if (components.fragment) {
			value += `#${encodeFragment(components.fragment)}`;
		}
		return URI.parse(value, true);
	}

	/** Restores a URI serialized by `toJSON`. */
	static revive(data: UriComponents | URI): URI;
	static revive(data: UriComponents | URI | undefined): URI | undefined;
	static revive(data: UriComponents | URI | null): URI | null;
	static revive(data: UriComponents | URI | undefined | null): URI | undefined | null;
	static revive(data: UriComponents | URI | undefined | null): URI | undefined | null {
		if (!data || data instanceof URI) {
			return data;
		}
		if ('external' in data && typeof data.external === 'string') {
			return URI.parse(data.external);
		}
		return URI.from(data);
	}

	/** Returns a URI with the specified decoded components changed. */
	with(change: { scheme?: string; authority?: string | null; path?: string | null; query?: string | null; fragment?: string | null; }): URI {
		const scheme = change.scheme === undefined ? this.scheme : change.scheme;
		const authority = change.authority === undefined ? this.authority : change.authority ?? '';
		const path = change.path === undefined ? this.path : change.path ?? '';
		const query = change.query === undefined ? this.query : change.query ?? '';
		const fragment = change.fragment === undefined ? this.fragment : change.fragment ?? '';
		if (scheme === this.scheme && authority === this.authority && path === this.path && query === this.query && fragment === this.fragment) return this;
		if (authority && path && !path.startsWith('/')) throw new TypeError('URI paths with an authority must start with /');

		const encoded = this.toEncodedComponents();
		let value = `${scheme}:`;
		if (authority || scheme === 'file') value += `//${authority}`;
		value += change.path === undefined ? encoded.path : encodePath(path);
		if (query) value += `?${change.query === undefined ? encoded.query : encodeQuery(query)}`;
		if (fragment) value += `#${change.fragment === undefined ? encoded.fragment : encodeFragment(fragment)}`;
		return URI.parse(value);
	}

	/** Joins path fragments while preserving the other URI components. */
	static joinPath(uri: URI, ...fragments: string[]): URI {
		if (!uri.path) {
			throw new TypeError(`URI has no path: ${uri.toString()}`);
		}
		const windowsFile = isWindows && uri.scheme === 'file';
		const encodedFragments = fragments.map(fragment => {
			const path = windowsFile ? fragment.replaceAll('\\', '/') : fragment;
			return path.split('/').map(encodeURIComponent).join('/');
		});
		if (!windowsFile) {
			return uri.withEncodedPath(paths.joinPath(uri.url.pathname, ...encodedFragments));
		}

		// A drive or UNC share is the filesystem root; '..' must not remove that URI segment.
		const firstSegment = uri.url.pathname.split('/')[1] ?? '';
		const root = firstSegment && (uri.authority || /^[A-Za-z]:$/.test(decodeURIComponent(firstSegment))) ? `/${firstSegment}` : '';
		const path = paths.joinPath(uri.url.pathname.slice(root.length) || '/', ...encodedFragments);
		const lastFragment = encodedFragments.filter(fragment => fragment.length > 0).at(-1) ?? uri.url.pathname;
		const joinedPath = path === '/' || lastFragment.endsWith('/') ? path : path.replace(/\/$/u, '');
		return uri.withEncodedPath(`${root}${joinedPath}`);
	}

	/** Changes the encoded path without merging escaped separators with path boundaries. */
	withEncodedPath(path: string): URI {
		validatePercentEncoding(path, "path");
		const url = new URL(this.url.href);
		url.pathname = path;
		return new URI(url);
	}

	/** Appends one decoded child name to a hierarchical URI. */
	joinPathSegment(name: string): URI {
		if (isWindows && this.scheme === 'file' && (name === '.' || name === '..')) {
			return URI.joinPath(this, name);
		}
		return this.withEncodedPath(paths.joinPath(this.url.pathname, name === '.' || name === '..' ? name : encodeURIComponent(name)));
	}

	toString(skipEncoding = false): string {
		if (!skipEncoding) return typeof this.value === 'string' ? this.value : this.value.href;
		const path = this.path.replaceAll('?', '%3F').replaceAll('#', '%23');
		const query = this.query.replaceAll('#', '%23');
		const authority = (this.authority || this.scheme === 'file') ? `//${this.authority}` : '';
		return `${this.scheme}:${authority}${path}${query ? `?${query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
	}

	toJSON(): UriComponents {
		const state: UriState = {
			$mid: MarshalledId.Uri,
			external: this.toString(),
			scheme: this.scheme,
			authority: this.authority,
			path: this.path,
			query: this.query,
			fragment: this.fragment,
		};
		return state;
	}
}

/** Converts a file URI to a path for the current operating system. */
function uriToFsPath(uri: URI): string {
	const path = uri.path;
	if (uri.authority) {
		const uncPath = `//${uri.authority}${path}`;
		return isWindows ? uncPath.replaceAll("/", "\\") : uncPath;
	}

	const hasDriveLetter = path.length >= 3
		&& path.charCodeAt(0) === CharCode.Slash
		&& ((path.charCodeAt(1) >= CharCode.A && path.charCodeAt(1) <= CharCode.Z)
			|| (path.charCodeAt(1) >= CharCode.a && path.charCodeAt(1) <= CharCode.z))
		&& path.charCodeAt(2) === CharCode.Colon;
	if (!hasDriveLetter) {
		return isWindows ? path.replaceAll('/', '\\') : path;
	}
	const filePath = `${path[1].toLowerCase()}${path.slice(2)}`;
	return isWindows ? filePath.replaceAll("/", "\\") : filePath;
}
