import { escapeRegExpCharacters } from './strings.js';

export interface IRelativePattern {
	readonly base: string;
	readonly pattern: string;
}

/** Matches the path glob subset used by editor language selectors. */
export function match(pattern: string | IRelativePattern, path: string): boolean {
	const normalizedPath = path.replaceAll('\\', '/');
	const candidate = typeof pattern === 'string'
		? normalizedPath
		: relativePath(pattern.base.replaceAll('\\', '/'), normalizedPath);
	const source = (typeof pattern === 'string' ? pattern : pattern.pattern).replaceAll('\\', '/');
	return globRegExp(source).test(candidate);
}

function relativePath(base: string, candidate: string): string {
	const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
	return candidate === normalizedBase ? '' : candidate.startsWith(`${normalizedBase}/`) ? candidate.slice(normalizedBase.length + 1) : candidate;
}

function globRegExp(pattern: string): RegExp {
	let expression = '^';
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index]!;
		if (character === '*') {
			if (pattern[index + 1] === '*') {
				index += 1;
				expression += '.*';
			} else expression += '[^/]*';
		} else if (character === '?') expression += '[^/]';
		else expression += escapeRegExpCharacters(character);
	}
	return new RegExp(`${expression}$`);
}
