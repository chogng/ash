import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { generateTreeSitterRegistry, readGrammarPackages } from './treeSitterRegistry.ts';

test('one package declaration generates both runtimes and detects stale registration', async t => {
	const root = await fixture(t);
	await generateTreeSitterRegistry({ root });
	await generateTreeSitterRegistry({ root, check: true });
	const metadata = await import(pathToFileURL(resolve(root, 'src/ash/platform/syntax/common/syntaxLanguages.generated.ts')).href);
	assert.deepEqual(metadata.syntaxLanguageDefinitions.map((language: { id: string; }) => language.id), ['demo', 'demoreact']);
	const rust = await readFile(resolve(root, 'crates/syntax/src/languages.generated.rs'), 'utf8');
	const web = await readFile(resolve(root, 'src/ash/workbench/services/treeSitter/browser/treeSitterGrammars.generated.ts'), 'utf8');
	assert.match(rust, /tree_sitter_demo::LANGUAGE/);
	assert.match(rust, /shared\/queries\/base.scm/);
	assert.match(web, /shared\/queries\/base.scm\?raw/);
	const packages = await readGrammarPackages(root);
	packages[0]!.grammars[0]!.languages[0]!.aliases.push('another-name');
	await writeFile(packages[0]!.manifest, JSON.stringify(packages[0]!.grammars));
	await assert.rejects(generateTreeSitterRegistry({ root, check: true }), /Stale Tree-sitter registration/);
	await generateTreeSitterRegistry({ root });
	await generateTreeSitterRegistry({ root, check: true });
});

test('conflicting aliases and uncovered extension languages fail before generation', async t => {
	const root = await fixture(t);
	const packages = await readGrammarPackages(root);
	const grammar = packages[0]!.grammars[0]!;
	grammar.languages[1]!.aliases.push('demo');
	await writeFile(packages[0]!.manifest, JSON.stringify([grammar]));
	await assert.rejects(readGrammarPackages(root), /Duplicate or invalid syntax language alias: demo/);
	grammar.languages[1]!.aliases.pop();
	await writeFile(packages[0]!.manifest, JSON.stringify([grammar]));
	await writeFile(resolve(root, 'extensions/demo/package.json'), JSON.stringify({ contributes: { languages: [{ id: 'missing' }] } }));
	await assert.rejects(readGrammarPackages(root), /Missing Tree-sitter registration for demo:missing/);
});

test('C variants and punctuation in code-fence aliases generate safe runtime bindings', async t => {
	const root = await fixture(t);
	const packages = await readGrammarPackages(root);
	const grammar = packages[0]!.grammars[0]!;
	grammar.languages[0]!.variant = 'C';
	grammar.languages[0]!.aliases = ['c++', 'c#'];
	await writeFile(packages[0]!.manifest, JSON.stringify([grammar]));
	await generateTreeSitterRegistry({ root });
	const rust = await readFile(resolve(root, 'crates/syntax/src/languages.generated.rs'), 'utf8');
	assert.match(rust, /"c\+\+" \| "c#" => Some\(Self::C\)/);
	grammar.languages[0]!.aliases.push('c"; unsafe');
	await writeFile(packages[0]!.manifest, JSON.stringify([grammar]));
	await assert.rejects(readGrammarPackages(root), /invalid syntax language alias/);
});

test('invalid bindings and query paths cannot enter generated source', async t => {
	const root = await fixture(t);
	const packages = await readGrammarPackages(root);
	const grammar = packages[0]!.grammars[0]!;
	grammar.rust.language = 'untrusted();';
	await writeFile(packages[0]!.manifest, JSON.stringify([grammar]));
	await assert.rejects(readGrammarPackages(root), /Invalid Rust grammar binding/);
	grammar.rust.language = 'tree_sitter_demo::LANGUAGE';
	grammar.highlights = ['@shared/../../outside.scm'];
	await writeFile(packages[0]!.manifest, JSON.stringify([grammar]));
	await assert.rejects(readGrammarPackages(root), /escapes its language package/);
});

async function fixture(t: { after(callback: () => Promise<void>): void; }): Promise<string> {
	const root = await mkdtemp(resolve(tmpdir(), 'ash-tree-sitter-registry-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
	await mkdir(resolve(root, 'extensions/demo/tree-sitter'), { recursive: true });
	await mkdir(resolve(root, 'extensions/shared/queries'), { recursive: true });
	await writeFile(resolve(root, 'extensions/shared/queries/base.scm'), '(identifier) @variable');
	await writeFile(resolve(root, 'extensions/demo/package.json'), JSON.stringify({ contributes: { languages: [{ id: 'demo' }, { id: 'demoreact' }] } }));
	await writeFile(resolve(root, 'extensions/demo/tree-sitter/grammars.json'), JSON.stringify([{
		name: 'demo', source: { crate: 'tree-sitter-demo', version: '1.0.0', root: '.' },
		wasm: { path: 'tree-sitter/demo.wasm', sha256: 'a'.repeat(64) },
		rust: { language: 'tree_sitter_demo::LANGUAGE' },
		highlights: ['@shared/queries/base.scm'], tags: [], folds: [], injections: [],
		languages: [
			{ id: 'demo', variant: 'Demo', editorLanguage: 'demo', editorIds: ['demo'], aliases: ['dm'] },
			{ id: 'demoreact', variant: 'Demoreact', editorLanguage: 'demoreact', editorIds: ['demoreact'], aliases: ['dmx'] },
		],
	}]));
	return root;
}
