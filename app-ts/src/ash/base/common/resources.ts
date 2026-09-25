import { isMacintosh, isWindows } from "./platform.js";
import { URI } from "./uri.js";

/** Metadata carried in a data URI before its content. */
export namespace DataUri {
	export const META_DATA_LABEL = 'label';
	export const META_DATA_MIME = 'mime';

	export function parseMetaData(resource: URI): Map<string, string> {
		const comma = resource.path.indexOf(',');
		const header = comma === -1 ? resource.path : resource.path.slice(0, comma);
		const [mime, ...parameters] = header.split(';');
		const metadata = new Map<string, string>();
		if (mime) {
			metadata.set(META_DATA_MIME, mime);
		}
		for (const parameter of parameters) {
			const separator = parameter.indexOf(':');
			if (separator > 0 && separator < parameter.length - 1) {
				metadata.set(parameter.slice(0, separator), decodeURIComponent(parameter.slice(separator + 1)));
			}
		}
		return metadata;
	}
}

/** Path comparison behavior selected for a resource. */
export enum ResourcePathCasing {
	Sensitive = "sensitive",
	Insensitive = "insensitive",
}

/**
 * URI identity operations shared across resource consumers.
 *
 * Implementations must return stable comparison keys for the same URI.
 */
export interface IExtUri {
	getComparisonKey(uri: URI): string;
	getComparisonKeyIgnoringFragment(uri: URI): string;
	isEqual(left: URI | undefined, right: URI | undefined): boolean;
	isEqualOrParent(base: URI, parentCandidate: URI, ignoreFragment?: boolean): boolean;
	isEqualIgnoringFragment(
		left: URI | undefined,
		right: URI | undefined,
	): boolean;
	ignorePathCasing(uri: URI): boolean;
}

/** Selects path comparison semantics for a URI. */
export type ResourcePathCasingProvider = (
	uri: URI,
) => ResourcePathCasing;

const UNRESERVED_CHARACTER = /^[A-Za-z\d\-._~]$/;

function normalizePercentEncoding(value: string): string {
	return value.replace(/%([0-9a-f]{2})/gi, (_match, hexadecimal: string) => {
		const character = String.fromCharCode(Number.parseInt(hexadecimal, 16));
		return UNRESERVED_CHARACTER.test(character)
			? character
			: `%${hexadecimal.toUpperCase()}`;
	});
}

function comparisonPath(path: string, ignoreCase: boolean): string {
	if (!ignoreCase) {
		return normalizePercentEncoding(path);
	}
	return path.split('/').map(segment => encodeURIComponent(decodeURIComponent(segment).toLowerCase())).join('/');
}

function keyPart(value: string): string {
	return `${value.length}:${value}`;
}

/**
 * Implements URI comparison with caller-selected path casing semantics.
 */
export class ExtUri implements IExtUri {
	private readonly pathCasing: ResourcePathCasingProvider;

	constructor(pathCasing: ResourcePathCasingProvider) {
		this.pathCasing = pathCasing;
	}

	getComparisonKey(uri: URI): string {
		return this.createComparisonKey(uri, true);
	}

	getComparisonKeyIgnoringFragment(uri: URI): string {
		return this.createComparisonKey(uri, false);
	}

	isEqual(left: URI | undefined, right: URI | undefined): boolean {
		if (left === right) return true;
		if (!left || !right) return false;
		return this.getComparisonKey(left) === this.getComparisonKey(right);
	}

	isEqualOrParent(base: URI, parentCandidate: URI, ignoreFragment = false): boolean {
		if (base.scheme !== parentCandidate.scheme || base.authority.toLowerCase() !== parentCandidate.authority.toLowerCase()) {
			return false;
		}
		if (normalizePercentEncoding(base.query) !== normalizePercentEncoding(parentCandidate.query)) {
			return false;
		}
		if (!ignoreFragment && normalizePercentEncoding(base.fragment) !== normalizePercentEncoding(parentCandidate.fragment)) {
			return false;
		}

		const ignoreCase = this.ignorePathCasing(base);
		const path = comparisonPath(base.path, ignoreCase).replace(/\/+$/u, '') || '/';
		const parent = comparisonPath(parentCandidate.path, ignoreCase).replace(/\/+$/u, '') || '/';
		return path === parent || path.startsWith(parent === '/' ? parent : `${parent}/`);
	}

	isEqualIgnoringFragment(
		left: URI | undefined,
		right: URI | undefined,
	): boolean {
		if (left === right) return true;
		if (!left || !right) return false;
		return this.getComparisonKeyIgnoringFragment(left)
			=== this.getComparisonKeyIgnoringFragment(right);
	}

	ignorePathCasing(uri: URI): boolean {
		return this.pathCasing(uri) === ResourcePathCasing.Insensitive;
	}

	private createComparisonKey(uri: URI, includeFragment: boolean): string {
		const path = comparisonPath(uri.path, this.ignorePathCasing(uri));
		const fragment = includeFragment
			? normalizePercentEncoding(uri.fragment)
			: "";

		return [
			keyPart(uri.scheme.toLowerCase()),
			keyPart(uri.authority.toLowerCase()),
			keyPart(path),
			keyPart(normalizePercentEncoding(uri.query)),
			keyPart(fragment),
		].join("");
	}
}

/** URI identity that preserves path casing. */
export const extUri = new ExtUri(() => ResourcePathCasing.Sensitive);

/**
 * URI identity biased toward the current native file-system path casing.
 *
 * Remote providers should supply an `ExtUri` matching their own semantics.
 */
export const extUriBiasedIgnorePathCase = new ExtUri((uri) => {
	if (
		uri.scheme === "file"
		&& (isWindows || isMacintosh)
	) {
		return ResourcePathCasing.Insensitive;
	}
	return ResourcePathCasing.Sensitive;
});

/** URI identity that ignores path casing for every scheme. */
export const extUriIgnorePathCase = new ExtUri(
	() => ResourcePathCasing.Insensitive,
);
