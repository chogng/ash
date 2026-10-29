import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { formatGeneratedTypeScript } from './lib/generatedTypeScript.ts';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseConfigFileTextToJson } from 'typescript';

const repository = resolve(import.meta.dirname, '..');

interface Declaration {
	id: string;
	extensions?: string[];
	filenames?: string[];
	filenamePatterns?: string[];
	firstLine?: string;
	configuration?: string;
}

interface Expression {
	source: string;
	flags: string;
}
interface Folding {
	offSide: boolean;
	markers?: { start: Expression; end: Expression };
}

function expression(value: unknown, owner: string): Expression {
	const source = typeof value === 'string' ? value : (value as { pattern?: unknown } | null)?.pattern;
	const flags = typeof value === 'string' ? '' : ((value as { flags?: unknown } | null)?.flags ?? '');
	if (
		typeof source !== 'string' ||
		!source.length ||
		source.length > 4096 ||
		/[\0\r\n]/.test(source) ||
		typeof flags !== 'string' ||
		!/^[dgimsuvy]*$/.test(flags)
	)
		throw new TypeError(`Invalid folding expression: ${owner}`);
	new RegExp(source, flags);
	return { source, flags };
}

async function readFolding(root: string, directory: string, configuration: string): Promise<Folding | undefined> {
	if (typeof configuration !== 'string' || isAbsolute(configuration) || configuration.includes('\\'))
		throw new TypeError(`Invalid language configuration path: ${directory}`);
	const base = resolve(root, 'extensions', directory),
		path = resolve(base, configuration);
	if (relative(base, path).split(sep).includes('..'))
		throw new RangeError('Language configuration escapes its package');
	const parsed = parseConfigFileTextToJson(path, await readFile(path, 'utf8'));
	if (parsed.error || !parsed.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config))
		throw new TypeError(`Invalid language configuration: ${path}`);
	const folding = parsed.config.folding;
	if (folding === undefined) return undefined;
	if (
		!folding ||
		typeof folding !== 'object' ||
		Array.isArray(folding) ||
		(folding.offSide !== undefined && typeof folding.offSide !== 'boolean')
	)
		throw new TypeError(`Invalid folding rules: ${path}`);
	const result: Folding = { offSide: folding.offSide === true };
	if (folding.markers !== undefined) {
		const markers = folding.markers;
		if (!markers || typeof markers !== 'object' || Array.isArray(markers))
			throw new TypeError(`Invalid folding markers: ${path}`);
		result.markers = { start: expression(markers.start, path), end: expression(markers.end, path) };
	}
	return result;
}

/** Generate shared identity, association and folding metadata from the owning language packages. */
export async function generateLanguageRegistry(options: { root?: string; check?: boolean } = {}): Promise<void> {
	const root = options.root ?? repository;
	const declarations: Declaration[] = [];
	const aliases = new Map<string, string>();
	const publicIds = new Set<string>();
	const foldingRules = new Map<string, Folding>();
	const grammarLanguages: { id: string; editorLanguage: string; editorIds: string[] }[] = [];
	for (const directory of (await readdir(resolve(root, 'extensions'))).sort()) {
		let manifest;
		try {
			manifest = JSON.parse(await readFile(resolve(root, 'extensions', directory, 'package.json'), 'utf8'));
		} catch (error) {
			if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
			throw error;
		}
		if (manifest.ashDistribution === 'marketplace') {
			continue;
		}
		for (const declaration of manifest.contributes?.languages ?? []) {
			if (typeof declaration.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(declaration.id))
				throw new TypeError(`Invalid language identity in ${directory}`);
			for (const key of ['extensions', 'filenames', 'filenamePatterns'] as const) {
				if (
					declaration[key] !== undefined &&
					(!Array.isArray(declaration[key]) ||
						!declaration[key].every(
							(value: unknown) =>
								typeof value === 'string' &&
								value.length > 0 &&
								value.length <= 256 &&
								!/[\0\r\n]/.test(value),
						))
				)
					throw new TypeError(`Invalid language ${key} in ${directory}`);
			}
			if (declaration.extensions?.some((extension: string) => !extension.startsWith('.')))
				throw new TypeError(`Invalid language extensions in ${directory}`);
			if (declaration.firstLine !== undefined) {
				if (
					typeof declaration.firstLine !== 'string' ||
					declaration.firstLine.length === 0 ||
					declaration.firstLine.length > 1024 ||
					/[\0\r\n]/.test(declaration.firstLine)
				)
					throw new TypeError(`Invalid language firstLine in ${directory}`);
				const pattern = new RegExp(
					declaration.firstLine.startsWith('^') ? declaration.firstLine : `^(?:${declaration.firstLine})`,
				);
				if (pattern.test(''))
					throw new TypeError(`Language firstLine must not match empty input in ${directory}`);
			}
			publicIds.add(declaration.id);
			declarations.push(declaration);
			if (declaration.configuration !== undefined) {
				const folding = await readFolding(root, directory, declaration.configuration);
				if (folding) foldingRules.set(declaration.id, folding);
			}
		}
		try {
			for (const grammar of JSON.parse(
				await readFile(resolve(root, 'extensions', directory, 'tree-sitter/grammars.json'), 'utf8'),
			))
				grammarLanguages.push(...grammar.languages);
		} catch (error) {
			if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
		}
	}
	for (const language of grammarLanguages) {
		if (language.editorIds.length && !publicIds.has(language.id) && language.id !== language.editorLanguage) {
			if (!publicIds.has(language.editorLanguage))
				throw new TypeError(`Unknown editor language: ${language.editorLanguage}`);
			if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(language.id) || aliases.has(language.id))
				throw new TypeError(`Invalid or duplicate legacy language identity: ${language.id}`);
			aliases.set(language.id, language.editorLanguage);
		}
	}
	const list = (values: string[] = []) =>
		`&[${[...new Set(values.map(value => value.toLowerCase()))].map(value => JSON.stringify(value)).join(', ')}]`;
	const source = `// Generated by build/languageRegistry.ts from language-package manifests, configurations and grammar identity bindings.
// Edit the owning language package, then run pnpm language:generate.

/// Normalize persisted legacy grammar IDs at the language boundary; unknown identities are preserved.
pub fn canonical_language_id(id: &str) -> &str {
    match id {
${[...aliases].map(([alias, id]) => `        ${JSON.stringify(alias)} => ${JSON.stringify(id)},`).join('\n')}
        _ => id,
    }
}

const DECLARATIONS: &[Association] = &[
${declarations
	.map(
		language => `    Association {
        id: ${JSON.stringify(language.id)},
        extensions: ${list(language.extensions)},
        filenames: ${list(language.filenames)},
        patterns: ${list(language.filenamePatterns)},
        first_line: ${language.firstLine === undefined ? 'None' : `Some(${JSON.stringify(language.firstLine)})`},
    },`,
	)
	.join('\n')}
];

const FOLDING_DECLARATIONS: &[FoldingDeclaration] = &[
${[...foldingRules]
	.map(
		([id, rules]) => `    FoldingDeclaration {
        id: ${JSON.stringify(id)},
        off_side: ${rules.offSide},
        markers: ${rules.markers ? `Some((${JSON.stringify(rules.markers.start.source)}, ${JSON.stringify(rules.markers.start.flags)}, ${JSON.stringify(rules.markers.end.source)}, ${JSON.stringify(rules.markers.end.flags)}))` : 'None'},
    },`,
	)
	.join('\n')}
];
`;
	const formatted = spawnSync('rustfmt', ['--edition', '2024', '--emit', 'stdout'], {
		input: source,
		encoding: 'utf8',
		windowsHide: true,
	});
	if (formatted.error) throw formatted.error;
	if (formatted.status !== 0) throw new Error(formatted.stderr);
	const web = `// Generated by build/languageRegistry.ts from language-package configuration files.
// Edit the owning language package, then run pnpm language:generate.

const declarations: Readonly<Record<string, { offSide: boolean; markers?: { start: { source: string; flags: string; }; end: { source: string; flags: string; }; }; }>> = ${JSON.stringify(Object.fromEntries(foldingRules), null, '\t')};
const rules = new Map(Object.entries(declarations).map(([id, rule]) => [id, Object.freeze({
	offSide: rule.offSide,
	...(rule.markers ? { markers: Object.freeze({ start: new RegExp(rule.markers.start.source, rule.markers.start.flags), end: new RegExp(rule.markers.end.source, rule.markers.end.flags) }) } : {}),
})]));

/** Immutable package configuration; caller-owned overrides stay with the Editor. */
export function getLanguageFoldingRules(languageId: string) { return rules.get(languageId); }
`;
	for (const [file, content] of [
		['crates/language/src/languages.generated.rs', formatted.stdout],
		['src/ash/platform/language/common/languageFolding.generated.ts', formatGeneratedTypeScript(web)],
	]) {
		const target = resolve(root, file!);
		let previous;
		try {
			previous = await readFile(target, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		if (previous === content) continue;
		if (options.check) throw new Error(`Stale language registration: ${file}; run pnpm language:generate`);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content!);
	}
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.length > 1 || args.some(arg => arg !== '--check'))
		throw new Error('Usage: node build/languageRegistry.ts [--check]');
	await generateLanguageRegistry({ check: args.includes('--check') });
}
