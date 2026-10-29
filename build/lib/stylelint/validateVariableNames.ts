import { readFileSync } from 'node:fs';

export interface KnownVariables {
	readonly colors: readonly string[];
	readonly others: readonly string[];
	readonly sizes: readonly string[];
}

export interface IValidator {
	(value: string, report: (variable: string, offset: number) => void): void;
}

export function readKnownVariables(path = new URL('./ash-known-variables.json', import.meta.url)): KnownVariables {
	const variables: KnownVariables = JSON.parse(readFileSync(path, 'utf8'));
	const known = new Set<string>();
	for (const category of ['colors', 'others', 'sizes'] as const) {
		const names = variables[category];
		if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !/^--[\w-]+$/.test(name))) {
			throw new Error(`Invalid CSS variable list: ${category}`);
		}
		if (JSON.stringify(names) !== JSON.stringify([...names].sort())) {
			throw new Error(`CSS variable list must be sorted: ${category}`);
		}
		for (const name of names) {
			if (known.has(name)) {
				throw new Error(`Duplicate CSS variable: ${name}`);
			}
			known.add(name);
		}
	}
	return variables;
}

export function getVariableNameValidator(variables: KnownVariables = readKnownVariables()): IValidator {
	const known = new Set([...variables.colors, ...variables.others, ...variables.sizes]);
	return (value, report) => {
		// Preserve offsets while ignoring examples in comments, strings, and URLs.
		const source = value.replace(/\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|url\([^)]*\)/gi, text => ' '.repeat(text.length));
		for (const match of source.matchAll(/(?<![\w-])var\(\s*(--[\w-]+)/g)) {
			if (!known.has(match[1]!)) {
				report(match[1]!, match.index);
			}
		}
	};
}
