/** Joins slash-separated paths and resolves dot segments without using Node APIs. */
export function joinPath(...fragments: string[]): string {
	const joined = fragments.filter(fragment => fragment.length > 0).join('/');
	if (!joined) {
		return '.';
	}

	const absolute = joined.startsWith('/');
	const trailingSeparator = /(?:\/|\/\.|\/\.\.)$/.test(joined);
	const segments: string[] = [];
	for (const segment of joined.split('/')) {
		if (!segment || segment === '.') {
			continue;
		}
		if (segment === '..' && segments.length > 0 && segments[segments.length - 1] !== '..') {
			segments.pop();
		} else if (segment === '..' && !absolute) {
			segments.push(segment);
		} else if (segment !== '..') {
			segments.push(segment);
		}
	}

	const path = `${absolute ? '/' : ''}${segments.join('/')}`;
	if (!path) {
		return absolute ? '/' : '.';
	}
	return trailingSeparator && path !== '/' ? `${path}/` : path;
}
