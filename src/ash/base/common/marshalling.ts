import { MarshalledId } from './marshallingIds.js';
import { URI, isUriComponents } from './uri.js';

/** Parses JSON command arguments, restoring explicitly tagged resource URIs. */
export function parse(text: string): unknown {
	return JSON.parse(text, (_key, value: unknown) => {
		if (!value || typeof value !== 'object' || !('$mid' in value) || value.$mid !== MarshalledId.Uri) {
			return value;
		}
		// Components must not inject URL delimiters when URI.from interpolates them.
		if (!isUriComponents(value)
			|| !/^[A-Za-z][A-Za-z\d+.-]*:$/u.test(`${value.scheme}:`)
			|| /[\x00-\x20\x7f/\\?#@]/u.test(value.authority ?? '')) {
			throw new TypeError('Invalid marshalled URI');
		}

		// Components are decoded, while Ash's optional external spelling preserves
		// escaped separators and callback delimiters. Both must identify the same URI.
		const components = URI.from(value, true);
		// Special URL schemes can reinterpret a path as a missing authority.
		if (!value.authority && components.authority) throw new TypeError('Invalid marshalled URI');
		if (!('external' in value)) return components;
		if (typeof value.external !== 'string') throw new TypeError('Invalid marshalled URI');
		const resource = URI.parse(value.external, true);
		if (resource.scheme !== components.scheme
			|| resource.authority !== components.authority
			|| resource.path !== components.path
			|| resource.query !== components.query
			|| resource.fragment !== components.fragment) {
			throw new TypeError('Inconsistent marshalled URI');
		}
		return resource;
	});
}
