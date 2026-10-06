import { escapeRegExpCharacters } from './strings.js';

export interface IRelativePattern {
	readonly base: string;
	readonly pattern: string;
}

export interface IExpression {
	[pattern: string]: boolean | { when: string; };
}

export type ParsedPattern = (path: string, basename?: string) => boolean;
export type ParsedExpression = (path: string, basename?: string, hasSibling?: (name: string) => boolean) => string | null;

export function parse(pattern: string | IRelativePattern): ParsedPattern;
export function parse(expression: IExpression): ParsedExpression;
export function parse(input: string | IRelativePattern | IExpression): ParsedPattern | ParsedExpression {
	if (typeof input === 'string' || typeof input.base === 'string' && typeof input.pattern === 'string') {
		const pattern = input as string | IRelativePattern;
		const regexp = globRegExp((typeof pattern === 'string' ? pattern : pattern.pattern).replaceAll('\\', '/'));
		return (path: string): boolean => {
			const normalized = path.replaceAll('\\', '/');
			return regexp.test(typeof pattern === 'string' ? normalized : relativePath(pattern.base.replaceAll('\\', '/'), normalized));
		};
	}
	const rules = Object.entries(input).filter(([, value]) => value !== false).map(([pattern, value]) => ({ pattern, value, matches: parse(pattern) }));
	return (path: string, name?: string, hasSibling?: (name: string) => boolean): string | null => {
		for (const rule of rules) {
			if (!rule.matches(path)) {
				continue;
			}
			if (typeof rule.value === 'object') {
				const filename = name ?? path.replaceAll('\\', '/').split('/').at(-1)!;
				const dot = filename.lastIndexOf('.');
				const stem = dot > 0 ? filename.slice(0, dot) : filename;
				if (!hasSibling?.(rule.value.when.replaceAll('$(basename)', stem))) {
					continue;
				}
			}
			return rule.pattern;
		}
		return null;
	};
}

/** Matches a path using the same glob grammar as configured expressions. */
export function match(pattern: string | IRelativePattern, path: string): boolean {
	return parse(pattern)(path);
}

function relativePath(base: string, candidate: string): string {
	const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
	return candidate === normalizedBase ? '' : candidate.startsWith(`${normalizedBase}/`) ? candidate.slice(normalizedBase.length + 1) : candidate;
}

function globRegExp(pattern: string): RegExp {
	return new RegExp(`^${globSource(pattern)}$`);
}

function globSource(pattern: string): string {
	let expression = '';
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index]!;
		if (character === '*') {
			if (pattern[index + 1] === '*') {
				index += 1;
				while (pattern[index + 1] === '*') {
					index += 1;
				}
				if (pattern[index + 1] === '/') {
					expression += '(?:[^/]+/)*';
					index += 1;
				} else {
					expression += '.*';
				}
			} else expression += '[^/]*';
		} else if (character === '?') {
			expression += '[^/]';
		} else if (character === '{') {
			let depth = 1;
			let end = index + 1;
			const alternatives: string[] = [];
			let start = end;
			for (; end < pattern.length && depth > 0; end += 1) {
				if (pattern[end] === '{') {
					depth += 1;
				} else if (pattern[end] === '}') {
					depth -= 1;
				}
				if (depth === 0 || depth === 1 && pattern[end] === ',') {
					alternatives.push(globSource(pattern.slice(start, end)));
					start = end + 1;
				}
			}
			if (depth === 0) {
				expression += `(?:${alternatives.join('|')})`;
				index = end - 1;
			} else {
				expression += '\\{';
			}
		} else if (character === '[') {
			const end = pattern.indexOf(']', index + 1);
			if (end > index + 1) {
				const content = pattern.slice(index + 1, end);
				const negate = content[0] === '!' || content[0] === '^';
				const characters = (negate ? content.slice(1) : content).replaceAll('\\', '\\\\').replaceAll('[', '\\[');
				expression += `(?!/)[${negate ? '^' : ''}${characters}]`;
				index = end;
			} else {
				expression += '\\[';
			}
		} else {
			expression += escapeRegExpCharacters(character);
		}
	}
	return expression;
}
