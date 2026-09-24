const URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const WINDOWS_URI_DRIVE_PATH = /^\/[A-Za-z]:\//;

export interface UriComponents {
	readonly scheme: string;
	readonly authority?: string;
	readonly path?: string;
	readonly query?: string;
	readonly fragment?: string;
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
	if (WINDOWS_DRIVE_PATH.test(value)) {
		throw new TypeError(
			`Windows paths must be created with URI.file(): ${value}`,
		);
	}
	if (!URI_SCHEME.test(value)) {
		throw new TypeError(`URI must be absolute: ${value}`);
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
 * Component accessors retain URI percent encoding so values round-trip without
 * changing reserved characters. Use `fsPath` when a decoded native path is
 * required for a `file:` URI.
 */
export class URI {
	private readonly url: URL;

	private constructor(url: URL) {
		this.url = url;
	}

	/** Parses and canonicalizes an absolute URI. */
	static parse(value: string, _strict = false): URI {
		void _strict;
		return new URI(parseUrl(value));
	}

	/**
	 * Creates a `file:` URI from an absolute POSIX, Windows drive, or UNC path.
	 */
	static file(path: string): URI {
		if (path.length === 0) {
			throw new TypeError("File path must not be empty");
		}

		const normalized = path.replaceAll("\\", "/");
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
			url.pathname = resourcePath;
			return new URI(url);
		}

		if (!normalized.startsWith("/") && !WINDOWS_DRIVE_PATH.test(path)) {
			throw new TypeError(`File path must be absolute: ${path}`);
		}

		const resourcePath = WINDOWS_DRIVE_PATH.test(path)
			? `/${normalized}`
			: normalized;
		const url = new URL("file:///");
		url.pathname = resourcePath;
		return new URI(url);
	}

	get scheme(): string {
		return this.url.protocol.slice(0, -1).toLowerCase();
	}

	get authority(): string {
		return this.url.host;
	}

	get path(): string {
		return this.url.pathname;
	}

	get query(): string {
		return this.url.search.slice(1);
	}

	get fragment(): string {
		return this.url.hash.slice(1);
	}

	/**
	 * Returns the decoded native path represented by a `file:` URI.
	 */
	get fsPath(): string {
		if (this.scheme !== "file") {
			throw new TypeError(`URI scheme is not file: ${this.scheme}`);
		}

		const decodedPath = decodeURIComponent(this.url.pathname);
		if (this.url.host) {
			return `\\\\${this.url.host}${decodedPath.replaceAll("/", "\\")}`;
		}
		if (WINDOWS_URI_DRIVE_PATH.test(decodedPath)) {
			return decodedPath.slice(1).replaceAll("/", "\\");
		}
		return decodedPath;
	}

	/** Returns a copy with a different percent-encoded path. */
	withPath(path: string): URI {
		const url = new URL(this.url.href);
		url.pathname = path;
		return new URI(parseUrl(url.href));
	}

	/** Returns a copy with a different percent-encoded query. */
	withQuery(query: string): URI {
		const url = new URL(this.url.href);
		url.search = query.length === 0 ? "" : `?${query}`;
		return new URI(parseUrl(url.href));
	}

	/** Returns a copy without a query component. */
	withoutQuery(): URI {
		return this.withQuery("");
	}

	/** Returns a copy with a different percent-encoded fragment. */
	withFragment(fragment: string): URI {
		const url = new URL(this.url.href);
		url.hash = fragment.length === 0 ? "" : `#${fragment}`;
		return new URI(parseUrl(url.href));
	}

	/** Returns a copy without a fragment component. */
	withoutFragment(): URI {
		return this.withFragment("");
	}

	toString(): string {
		return this.url.href;
	}

	toJSON(): string {
		return this.toString();
	}
}
