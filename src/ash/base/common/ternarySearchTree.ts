import { URI } from './uri.js';

interface IndexedValue<V> {
	readonly segments: readonly string[];
	value: V;
}

/**
 * Hierarchical keys indexed in segment order. Ancestor lookup searches exact
 * prefixes, so escaped separators remain part of a URI segment. The ordered
 * representation avoids allocating a node for every character or path segment.
 */
export class TernarySearchTree<K, V> {
	private readonly entries: IndexedValue<V>[] = [];

	private constructor(private readonly segmentsFor: (key: K) => readonly string[]) { }

	static forUris<E>(ignorePathCasing: (key: URI) => boolean = () => false, ignoreQueryAndFragment: (key: URI) => boolean = () => false): TernarySearchTree<URI, E> {
		return new TernarySearchTree(resource => {
			const encoded = resource.toEncodedComponents();
			const path = encoded.path.replace(/\/+$/u, '');
			const absolute = !path || path.startsWith('/');
			const segments = [resource.scheme.toLowerCase(), resource.authority.toLowerCase(), absolute ? '/' : ''];
			const ignoreCase = ignorePathCasing(resource);
			if (path) {
				for (const segment of (absolute ? path.slice(1) : path).split('/')) {
					segments.push('/' + (ignoreCase ? encodeURIComponent(decodeURIComponent(segment).toLowerCase()) : normalizeEncoding(segment)));
				}
			}
			if (!ignoreQueryAndFragment(resource)) {
				if (encoded.query) segments.push('?' + normalizeEncoding(encoded.query));
				if (encoded.fragment) segments.push('#' + normalizeEncoding(encoded.fragment));
			}
			return segments;
		});
	}

	/** Inserts or replaces one exact key and returns its previous value. */
	set(key: K, element: V): V | undefined {
		const segments = this.segmentsFor(key);
		const index = this.lowerBound(segments, segments.length);
		const entry = this.entries[index];
		if (entry && compareSegments(entry.segments, segments, segments.length) === 0) {
			const previous = entry.value;
			entry.value = element;
			return previous;
		}
		this.entries.splice(index, 0, { segments, value: element });
		return undefined;
	}

	/** Returns the value at the longest stored segment prefix, including an exact match. */
	findSubstr(key: K): V | undefined {
		const segments = this.segmentsFor(key);
		for (let length = segments.length; length > 0; length--) {
			const entry = this.entries[this.lowerBound(segments, length)];
			if (entry && compareSegments(entry.segments, segments, length) === 0) return entry.value;
		}
		return undefined;
	}

	private lowerBound(segments: readonly string[], length: number): number {
		let lower = 0;
		let upper = this.entries.length;
		while (lower < upper) {
			const middle = lower + Math.floor((upper - lower) / 2);
			if (compareSegments(this.entries[middle]!.segments, segments, length) < 0) lower = middle + 1;
			else upper = middle;
		}
		return lower;
	}
}

function compareSegments(left: readonly string[], right: readonly string[], rightLength: number): number {
	for (let index = 0; index < Math.min(left.length, rightLength); index++) {
		if (left[index]! < right[index]!) return -1;
		if (left[index]! > right[index]!) return 1;
	}
	return left.length - rightLength;
}

function normalizeEncoding(value: string): string {
	return value.replace(/%[\da-f]{2}/gi, escape => {
		const decoded = String.fromCharCode(Number.parseInt(escape.slice(1), 16));
		return /^[A-Za-z\d._~-]$/u.test(decoded) ? decoded : escape.toUpperCase();
	});
}
