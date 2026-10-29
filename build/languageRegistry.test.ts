import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { format } from './format.ts';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { generateLanguageRegistry } from './languageRegistry.ts';

test('language associations come from package contributions and stale output is rejected', async t => {
	const root = await mkdtemp(resolve(tmpdir(), 'ash-language-registry-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(resolve(root, 'extensions/demo/tree-sitter'), { recursive: true });
	const manifest = resolve(root, 'extensions/demo/package.json');
	await writeFile(
		manifest,
		JSON.stringify({
			contributes: { languages: [{ id: 'demo', extensions: ['.demo'], filenames: ['DemoFile'] }] },
		}),
	);
	await writeFile(resolve(root, 'extensions/demo/tree-sitter/grammars.json'), JSON.stringify([{ languages: [{ id: 'legacy-demo', editorLanguage: 'demo', editorIds: ['demo'] }] }]));
	await mkdir(resolve(root, 'extensions/optional'), { recursive: true });
	await writeFile(
		resolve(root, 'extensions/optional/package.json'),
		JSON.stringify({
			ashDistribution: 'marketplace',
			contributes: { languages: [{ id: 'optional-language', extensions: ['.optional'] }] },
		}),
	);
	await generateLanguageRegistry({ root });
	await generateLanguageRegistry({ root, check: true });
	const frontendPath = resolve(root, 'src/ash/platform/language/common/languageFolding.generated.ts');
	const frontend = await readFile(frontendPath, 'utf8');
	assert.equal(format(frontendPath, frontend), frontend);
	const generated = await readFile(resolve(root, 'crates/language/src/languages.generated.rs'), 'utf8');
	assert.match(generated, /"legacy-demo" => "demo"/);
	assert.doesNotMatch(generated, /optional-language/);
	assert.match(generated, /filenames: &\["demofile"\]/);
	await writeFile(manifest, JSON.stringify({ contributes: { languages: [{ id: 'demo', extensions: ['.changed'] }] } }));
	await assert.rejects(generateLanguageRegistry({ root, check: true }), /Stale language registration/);
	await generateLanguageRegistry({ root });
	await generateLanguageRegistry({ root, check: true });
	await writeFile(manifest, JSON.stringify({ contributes: { languages: [{ id: 'bad/id' }] } }));
	await assert.rejects(generateLanguageRegistry({ root }), /Invalid language identity/);
});

test('JSONC folding configuration generates both runtimes and configuration edits invalidate outputs', async t => {
	const root = await mkdtemp(resolve(tmpdir(), 'ash-folding-registry-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
	await mkdir(resolve(root, 'extensions/demo'), { recursive: true });
	const manifest = resolve(root, 'extensions/demo/package.json');
	await writeFile(manifest, JSON.stringify({ contributes: { languages: [{ id: 'demo', configuration: './rules.json' }] } }));
	const rules = resolve(root, 'extensions/demo/rules.json');
	await writeFile(
		rules,
		`// Folding rules can use JSONC and expression flags.
{ "folding": { "offSide": true, "markers": { "start": { "pattern": "^BEGIN", "flags": "i" }, "end": "^END" }, }, }`,
	);
	await generateLanguageRegistry({ root });
	const generated = await import(pathToFileURL(resolve(root, 'src/ash/platform/language/common/languageFolding.generated.ts')).href);
	assert.equal(generated.getLanguageFoldingRules('demo').offSide, true);
	assert.equal(generated.getLanguageFoldingRules('demo').markers.start.test('begin'), true);
	assert.equal(generated.getLanguageFoldingRules('unknown'), undefined);
	await generateLanguageRegistry({ root, check: true });
	await writeFile(rules, '{ "folding": { "offSide": false } }');
	await assert.rejects(generateLanguageRegistry({ root, check: true }), /Stale language registration/);
	await generateLanguageRegistry({ root });
	await writeFile(resolve(root, 'src/ash/platform/language/common/languageFolding.generated.ts'), 'stale');
	await assert.rejects(generateLanguageRegistry({ root, check: true }), /languageFolding.generated.ts/);
	await writeFile(manifest, JSON.stringify({ contributes: { languages: [{ id: 'demo', configuration: '../outside.json' }] } }));
	await assert.rejects(generateLanguageRegistry({ root }), /escapes its package/);
});
