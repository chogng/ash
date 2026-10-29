import { isWindows } from './platform.js';

/** Path operations used to interpret user-entered filesystem paths. */
export interface IPath {
	normalize(path: string): string;
	isAbsolute(path: string): boolean;
	join(...paths: string[]): string;
	/** Resolves against an explicit absolute base; browser code has no process cwd. */
	resolve(...paths: string[]): string;
	relative(from: string, to: string): string;
	dirname(path: string): string;
	basename(path: string, suffix?: string): string;
	extname(path: string): string;
	readonly sep: '/' | '\\';
}

export const posix: IPath = {
	sep: '/',
	isAbsolute: path => path.startsWith('/'),
	normalize: normalizePosix,
	join: (...paths) => normalizePosix(paths.filter(Boolean).join('/')),
	resolve: (...paths) => resolveSegments(paths, false),
	relative: (from, to) => relativeSegments(from, to, false),
	dirname: path => parentPath(path, false),
	basename: (path, suffix) => pathBasename(path, false, suffix),
	extname: path => pathExtension(path, false),
};

export const win32: IPath = {
	sep: '\\',
	join: (...paths) => win32.normalize(paths.filter(Boolean).join('\\')),
	resolve: (...paths) => resolveSegments(paths, true),
	relative: (from, to) => relativeSegments(from, to, true),
	dirname: path => parentPath(path, true),
	basename: (path, suffix) => pathBasename(path, true, suffix),
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

/** Root parsing is lexical: it neither probes a filesystem nor selects its casing policy. */
function pathRoot(path: string, windows: boolean): { device: string; root: string; tail: string } {
	const value = windows ? path.replaceAll('\\', '/') : path;
	const unc = windows ? /^\/\/([^/]+)\/([^/]+)(?:\/|$)/.exec(value) : null;
	const drive = windows ? (/^[a-z]:/i.exec(value)?.[0] ?? '') : '';
	const device = unc ? `//${unc[1]}/${unc[2]}` : drive;
	const absolute = unc !== null || value.slice(device.length).startsWith('/');
	const root = device + (absolute ? '/' : '');
	return { device, root, tail: value.slice(root.length) };
}

function resolveSegments(paths: readonly string[], windows: boolean): string {
	let current = '';
	for (const path of paths) {
		if (!path) continue;
		const part = pathRoot(path, windows);
		const base = pathRoot(current, windows);
		if (part.root.endsWith('/')) {
			current = part.device || !windows ? part.root + part.tail : base.device + '/' + part.tail;
		} else if (part.device) {
			if (base.device.toLowerCase() !== part.device.toLowerCase() || !base.root.endsWith('/')) {
				throw new TypeError('Drive-relative paths require an absolute base on the same drive');
			}
			current += '/' + part.tail;
		} else {
			current += (current ? '/' : '') + part.tail;
		}
	}
	const root = pathRoot(current, windows);
	if (!root.root.endsWith('/')) throw new TypeError('Path resolution requires an absolute base');
	const normalized = (windows ? win32 : posix).normalize(current);
	return normalized.length > root.root.length ? normalized.replace(windows ? /[\\/]+$/ : /\/+$/, '') : normalized;
}

function relativeSegments(from: string, to: string, windows: boolean): string {
	const source = resolveSegments([from], windows);
	const target = resolveSegments([to], windows);
	const left = pathRoot(source, windows);
	const right = pathRoot(target, windows);
	const equal = (a: string, b: string): boolean => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
	if (!equal(left.device, right.device)) return target;
	const a = left.tail.split('/').filter(Boolean);
	const b = right.tail.split('/').filter(Boolean);
	let common = 0;
	while (common < a.length && common < b.length && equal(a[common]!, b[common]!)) common++;
	return [...a.slice(common).map(() => '..'), ...b.slice(common)].join(windows ? '\\' : '/');
}

function parentPath(path: string, windows: boolean): string {
	if (!path) return '.';
	const value = windows ? path.replaceAll('\\', '/') : path;
	const { root } = pathRoot(value, windows);
	const end = value.replace(/\/+$/, '').lastIndexOf('/');
	if (end >= root.length) return path.slice(0, end);
	if (!root) return '.';
	return path.slice(0, root.length);
}

/** Returns an extension using the current host's filename separators. */
export function extname(path: string): string {
	return (isWindows ? win32 : posix).extname(path);
}

function pathExtension(path: string, windows: boolean): string {
	const name = pathBasename(path, windows);
	const dot = name.lastIndexOf('.');
	return dot > 0 && name !== '..' ? name.slice(dot) : '';
}

function pathBasename(path: string, windows: boolean, suffix?: string): string {
	const subject = windows ? path.replace(/^[a-z]:/i, '') : path;
	const parts = subject.split(windows ? /[\\/]+/ : /\/+/);
	// Ignore trailing separators when selecting the final name.
	const name = parts.reverse().find(part => part.length > 0) ?? '';
	return suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
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
