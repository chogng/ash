import { globSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getVariableNameValidator } from './lib/stylelint/validateVariableNames.ts';
import type { IValidator } from './lib/stylelint/validateVariableNames.ts';
import { findClassAttributeSubstringSelector, findRootAnchoredHas, findWorkbenchSelector } from './lib/stylelint/validateHasSelectors.ts';
import { validateDesignTokens } from './lib/stylelint/validateDesignTokens.ts';

const repositoryRoot = resolve(import.meta.dirname, '..');
const defaultSources = ['src/**/*.css', 'extensions/**/*.css'];
const testPath = /(?:^|[/\\])(?:test|test-data|testData|node_modules)(?:[/\\])/;

export function resolveStylelintMatches(sources: readonly string[], root = repositoryRoot): string[] {
	const files = new Set<string>();
	for (const source of sources) {
		const pattern = source.replaceAll('\\', '/');
		const path = resolve(root, source);
		let matches: string[];
		if (/[*?{[]/.test(pattern)) {
			matches = globSync(pattern, { cwd: root });
		} else if (statSync(path).isDirectory()) {
			matches = globSync(`${pattern}/**/*.css`, { cwd: root });
		} else {
			matches = [source];
		}
		const selected = matches.map(match => resolve(root, match)).filter(file => file.endsWith('.css') && !testPath.test(file));
		if (selected.length === 0) {
			throw new Error(`No production CSS files matched: ${source}`);
		}
		for (const file of selected) {
			const name = relative(root, file);
			if (name.startsWith(`..${sep}`) || isAbsolute(name)) {
				throw new Error(`CSS path must belong to the repository: ${source}`);
			}
			files.add(file);
		}
	}
	return [...files].sort();
}

export function checkStyles(files: readonly string[], validator: IValidator = getVariableNameValidator(), root = repositoryRoot): string[] {
	const errors: string[] = [];
	for (const file of files) {
		const content = readFileSync(file, 'utf8');
		const name = relative(root, file).replaceAll('\\', '/');
		const report = (offset: number, message: string): void => {
			const lines = content.slice(0, offset).split('\n');
			const column = lines[lines.length - 1]!.length + 1;
			errors.push(`${name}:${lines.length}:${column}: ${message}`);
		};
		validator(content, (variable, offset) => report(offset, `Unknown CSS variable ${variable}`));
		const rootHas = findRootAnchoredHas(content);
		if (rootHas !== undefined) { report(rootHas, 'Root-anchored :has() causes page-wide style invalidation; project state through a class owned by the component.'); }
		const classSubstring = findClassAttributeSubstringSelector(content);
		if (classSubstring !== undefined) { report(classSubstring, 'Class attribute substring selectors react to unrelated class changes; select a stable class.'); }
		if (/^src\/ash\/(?:base|platform|editor)\//.test(name)) {
			const workbenchRoot = findWorkbenchSelector(content);
			if (workbenchRoot !== undefined) { report(workbenchRoot, 'Lower-layer CSS must not depend on the .ash-workbench root owned by Workbench.'); }
		}
	}
	return errors;
}

export function checkStyleSuggestions(files: readonly string[], root = repositoryRoot): string[] {
	return files.flatMap(file => {
		const content = readFileSync(file, 'utf8');
		return validateDesignTokens(content).map(suggestion => {
			const lines = content.slice(0, suggestion.offset).split('\n');
			return `${relative(root, file).replaceAll('\\', '/')}:${lines.length}:${lines.at(-1)!.length + 1}: [${suggestion.category}] ${suggestion.message}`;
		});
	});
}

export function stylelint(sources?: readonly string[]): number {
	const selected = sources ?? globSync(defaultSources, { cwd: repositoryRoot }).filter(file => !testPath.test(file));
	const files = resolveStylelintMatches(selected);
	if (!files.length) {
		throw new Error('No production CSS files found.');
	}
	const errors = checkStyles(files);
	for (const error of errors) {
		console.error(error);
	}
	const suggestionFiles = sources ? files : files.filter(file => relative(repositoryRoot, file).replaceAll('\\', '/').startsWith('src/ash/sessions/'));
	const suggestions = checkStyleSuggestions(suggestionFiles);
	for (const suggestion of suggestions) {
		console.warn(suggestion);
	}
	console.log(`Stylelint: checked ${files.length} CSS files; ${errors.length} errors; ${suggestions.length} design suggestions.`);
	if (errors.some(error => error.includes('Unknown CSS variable'))) {
		console.error('Registered colors and sizes belong in build/lib/stylelint/ash-known-variables.json. Run pnpm stylelint:update after changing token registrations; review other variables against their defining owner.');
	}
	return errors.length ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try {
		const sources = process.argv.slice(2);
		if (sources.some(source => source.startsWith('-'))) {
			throw new Error('Usage: pnpm stylelint [file|directory|glob ...]');
		}
		process.exitCode = stylelint(sources.length ? sources : undefined);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
