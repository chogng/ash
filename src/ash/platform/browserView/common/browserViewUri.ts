import { URI } from '../../../base/common/uri.js';

/** Resource identity is independent of the website currently loaded in the page. */
export namespace BrowserViewUri {
	export const scheme = 'ash-browser';

	export function forId(id: string): URI {
		return URI.from({ scheme, path: `/${id}` });
	}

	export function parse(resource: URI): { id: string; } | undefined {
		if (resource.scheme !== scheme) { return undefined; }
		const id = resource.path.replace(/^\//, '');
		return id ? { id } : undefined;
	}

	export function getId(resource: URI): string | undefined {
		return parse(resource)?.id;
	}
}
