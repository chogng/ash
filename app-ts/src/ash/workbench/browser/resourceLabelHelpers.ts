import type { URI } from '../../base/common/uri.js';

export function basenameOrAuthority(resource: URI): string {
	const path = decodeURIComponent(resource.path).replace(/\/+$/u, '');
	const name = path.slice(path.lastIndexOf('/') + 1);
	return name || resource.authority || resource.toString();
}

export function dirnameResource(resource: URI): URI | undefined {
	const path = resource.path.replace(/\/+$/u, '');
	const separator = path.lastIndexOf('/');
	if (separator < 0) return undefined;
	return resource.withPath(path.slice(0, separator + 1) || '/');
}

export function isEqualResource(left: URI | undefined, right: URI | undefined): boolean {
	return left?.toString() === right?.toString();
}
