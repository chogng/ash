import { isWindows } from './platform.js';

/** Path operations used to interpret user-entered filesystem paths. */
export interface IPath {
	normalize(path: string): string;
	isAbsolute(path: string): boolean;
	extname(path: string): string;
	readonly sep: '/' | '\\';
}

export const posix: IPath = {
	sep: '/',
	isAbsolute: path => path.startsWith('/'),
	normalize: normalizePosix,
	extname: path => pathExtension(path, false),
};

export const win32: IPath = {
	sep: '\\',
	isAbsolute: path => /^[\\/]/.test(path) || /^[a-z]:[\\/]/i.test(path),
	extname: path => pathExtension(path, true),
	normalize(path: string): string {
		const slashes = path.replaceAll('\\', '/');
		const unc = /^\/\/([^/]+)\/+([^/]+)\/*/.exec(slashes);
		const drive = /^([a-z]:)(\/+)?/i.exec(slashes);
		const leading = /^\/+/.exec(slashes);
		const root = unc ? `//${unc[1]}/${unc[2]}/` : drive ? drive[1] + (drive[2] ? '/' : '') : leading ? '/' : '';
		const remainder = slashes.slice(unc?.[0].length ?? drive?.[0].length ?? leading?.[0].length ?? 0);
		const rooted = root.endsWith('/');
		const normalized = normalizePosix((rooted ? '/' : '') + remainder);
		const tail = rooted ? normalized.slice(1) : normalized;
		const result = root + tail;
		return result.replaceAll('/', '\\');
	},
};

/** Returns an extension using the current host's filename separators. */
export function extname(path: string): string {
	return (isWindows ? win32 : posix).extname(path);
}

function pathExtension(path: string, windows: boolean): string {
	const subject = windows ? path.replace(/^[a-z]:/i, '') : path;
	const parts = subject.split(windows ? /[\\/]+/ : /\/+/);
	// Trailing separators identify a directory, whose last segment still has an extension.
	const name = parts.reverse().find(part => part.length > 0) ?? '';
	const dot = name.lastIndexOf('.');
	return dot > 0 && name !== '..' ? name.slice(dot) : '';
}

function normalizePosix(path: string): string {
	const result = joinPath(path);
	if (path.endsWith('/')) return result === '.' ? './' : result;
	return result.length > 1 && result.endsWith('/') ? result.slice(0, -1) : result;
}

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
