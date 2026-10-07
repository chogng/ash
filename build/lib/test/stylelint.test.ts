import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { checkStyles, checkStyleSuggestions, resolveStylelintMatches } from '../../stylelint.ts';
import { findClassAttributeSubstringSelector, findRootAnchoredHas } from '../stylelint/validateHasSelectors.ts';
import { validateDesignTokens } from '../stylelint/validateDesignTokens.ts';
import { getVariableNameValidator, readKnownVariables } from '../stylelint/validateVariableNames.ts';

const root = resolve(import.meta.dirname, '../../..');
const known = { colors: ['--ash-foreground'], others: ['--component-width'], sizes: ['--ash-spacing-size80'] };

test('CSS variable checks find unknown names in nested fallbacks without treating examples as references', () => {
	const validate = getVariableNameValidator(known);
	const errors: string[] = [];
	validate(`
/* var(--comment-example) */
.a { content: "var(--string-example)"; background-image: url(data:var(--url-example));
  color: var( --ash-foreground, var(--misspelled-color));
  width: var(--component-width); padding: var(--ash-spacing-size80);
  height: var(/* documented */--missing-size, var(--another-missing));
  content: custom-var(--not-a-css-variable-function);
}`, name => errors.push(name));
	assert.deepEqual(errors, ['--misspelled-color', '--missing-size', '--another-missing']);
	const second: string[] = [];
	validate('width: var(--component-width);', name => second.push(name));
	assert.deepEqual(second, []);
});

test('manifest loading rejects malformed, duplicate, and unsorted variables', () => {
	const directory = mkdtempSync(join(tmpdir(), 'ash-stylelint-manifest-'));
	const file = join(directory, 'variables.json');
	try {
		for (const variables of [
			{ ...known, colors: ['not-a-custom-property'] },
			{ ...known, others: ['--ash-foreground'] },
			{ ...known, sizes: ['--z', '--a'] },
			{ ...known, sizes: [null] },
			{ colors: known.colors, others: known.others },
		]) {
			writeFileSync(file, JSON.stringify(variables));
			assert.throws(() => readKnownVariables(pathToFileURL(file)), /CSS variable/);
		}
		writeFileSync(file, JSON.stringify(known));
		assert.deepEqual(readKnownVariables(pathToFileURL(file)), known);
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test('source selection deduplicates files, excludes fixtures, and rejects unmatched and external paths', () => {
	const directory = mkdtempSync(join(tmpdir(), 'ash-stylelint-selection-'));
	try {
		mkdirSync(join(directory, 'browser/test'), { recursive: true });
		writeFileSync(join(directory, 'browser/one.css'), '');
		writeFileSync(join(directory, 'browser/test/fixture.css'), '');
		assert.deepEqual(resolveStylelintMatches(['browser', 'browser/**/*.css', 'browser/one.css'], directory), [join(directory, 'browser/one.css')]);
		assert.throws(() => resolveStylelintMatches(['missing/**/*.css'], directory), /No production CSS/);
		assert.throws(() => resolveStylelintMatches(['browser/test/fixture.css'], directory), /No production CSS/);
		assert.throws(() => resolveStylelintMatches([join(root, 'src/ash/base/browser/ui/button/button.css')], directory), /must belong/);
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test('CLI reports file and location, fails on misspellings, and never updates the manifest', () => {
	mkdirSync(join(root, '.build'), { recursive: true });
	const directory = mkdtempSync(join(root, '.build/stylelint-case-'));
	const file = join(directory, 'example.css');
	const manifest = join(root, 'build/lib/stylelint/ash-known-variables.json');
	const before = readFileSync(manifest, 'utf8');
	try {
		writeFileSync(file, '.a {\n  color: var(--ash-foreground);\n  gap: var(--ash-nonexistent-spacing, var(--ash-foreground));\n}');
		const errors = checkStyles([file], getVariableNameValidator(known), directory);
		assert.deepEqual(errors, ['example.css:3:8: Unknown CSS variable --ash-nonexistent-spacing']);
		const failure = spawnSync(process.execPath, ['build/stylelint.ts', file], { cwd: root, encoding: 'utf8' });
		assert.equal(failure.status, 1, failure.stderr);
		assert.match(failure.stderr, /example\.css:3:8: Unknown CSS variable --ash-nonexistent-spacing/);
		writeFileSync(file, '.a { color: var(--ash-foreground); }');
		const success = spawnSync(process.execPath, ['build/stylelint.ts', file], { cwd: root, encoding: 'utf8' });
		assert.equal(success.status, 0, success.stderr);
		assert.equal(readFileSync(manifest, 'utf8'), before);
	} finally {
		rmSync(directory, { recursive: true });
	}
});


test('hygiene stops before registry verification on CSS errors and preserves the verifier exit code', () => {
	const directory = mkdtempSync(join(tmpdir(), 'ash-stylelint-hygiene-'));
	const source = join(directory, 'src/example.css');
	const manager = join(directory, 'manager.cjs');
	try {
		for (const name of ['build/hygiene.ts', 'build/stylelint.ts', 'build/lib/stylelint/validateVariableNames.ts', 'build/lib/stylelint/validateHasSelectors.ts', 'build/lib/stylelint/validateDesignTokens.ts']) {
			mkdirSync(join(directory, name, '..'), { recursive: true });
			copyFileSync(join(root, name), join(directory, name));
		}
		writeFileSync(join(directory, 'build/lib/stylelint/ash-known-variables.json'), JSON.stringify(known));
		mkdirSync(join(directory, 'src'), { recursive: true });
		writeFileSync(manager, "require('node:fs').writeFileSync('called.json', JSON.stringify(process.argv.slice(2))); process.exitCode = 23;");
		writeFileSync(source, '.a { color: var(--not-registered); }');
		const options = { cwd: directory, encoding: 'utf8' as const, env: { ...process.env, npm_execpath: manager } };
		const failure = spawnSync(process.execPath, ['build/hygiene.ts'], options);
		assert.equal(failure.status, 1, failure.stderr);
		assert.equal(existsSync(join(directory, 'called.json')), false);
		writeFileSync(source, '.a { color: var(--ash-foreground); }');
		const verification = spawnSync(process.execPath, ['build/hygiene.ts'], options);
		assert.equal(verification.status, 23, verification.stderr);
		assert.deepEqual(JSON.parse(readFileSync(join(directory, 'called.json'), 'utf8')), [
			'--dir', '.', 'test:unit', '--run', 'src/ash/workbench/test/common/design-tokens.test.ts',
		]);
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test('selector checks distinguish page roots and class substrings from component-local selectors and examples', () => {
	for (const selector of ['body:has(.open)', 'html.busy:has(.open)', ':root:has(.open)', '.ash-workbench.active:is(.focused, .busy):has(.open)']) {
		const source = `@media (min-width: 600px) {\n${selector} { color: red; }\n}`;
		assert.equal(findRootAnchoredHas(source), source.lastIndexOf(':has('), selector);
	}
	for (const selector of ['.panel:has(.open)', 'body .panel:has(.open)', '.ash-workbench-shell:has(.open)', '.ash-workbench > .panel:has(.open)']) {
		assert.equal(findRootAnchoredHas(`${selector} { color: red; }`), undefined, selector);
	}
	for (const operator of ['*=', '^=', '$=']) {
		assert.equal(findClassAttributeSubstringSelector(`.a [class${operator}"item"] { color: red; }`), 3);
	}
	const examples = '/* body:has(.a) { } */ .a { content: "body:has(.b) { [class*=item] }"; }';
	assert.equal(findRootAnchoredHas(examples), undefined);
	assert.equal(findClassAttributeSubstringSelector(examples), undefined);
	assert.equal(findClassAttributeSubstringSelector('[class~="item"] { color: red; }'), undefined);
});

test('CSS layer checks reject Workbench roots only in lower-layer production CSS', () => {
	const directory = mkdtempSync(join(tmpdir(), 'ash-stylelint-layers-'));
	try {
		const files = ['base', 'platform', 'editor', 'workbench'].map(layer => join(directory, `src/ash/${layer}/browser/component.css`));
		for (const file of files) {
			mkdirSync(join(file, '..'), { recursive: true });
			writeFileSync(file, '.ash-workbench .component { color: var(--ash-foreground); }');
		}
		const errors = checkStyles(files, getVariableNameValidator(known), directory);
		assert.equal(errors.length, 3);
		for (const [index, layer] of ['base', 'platform', 'editor'].entries()) {
			assert.equal(errors[index], `src/ash/${layer}/browser/component.css:1:1: Lower-layer CSS must not depend on the .ash-workbench root owned by Workbench.`);
		}
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test('design suggestions respect roles, on-scale spacing, computed geometry, and thicker focus strokes', () => {
	const css = `
/* .fake { padding: 5px; } */
.a { content: "padding: 5px;"; padding: 8px 12px; gap: calc(5px + var(--gap)); margin: auto; outline-width: 2px; }
.b { padding: 0 5px; font-weight: 500; font-size: 13px; border-radius: 14px; border: 1px solid currentColor; }
.lxicon-close { font-size: 14px; }
.lxicon { font-size: 12px; }
.c { width: 5px; border-radius: 50%; margin: -3px; font-size: var(--ash-fontSize-label1); font-weight: inherit; }
`;
	const suggestions = validateDesignTokens(css);
	assert.deepEqual(suggestions.map(({ category }) => category), ['spacing', 'weight', 'font-size', 'radius', 'stroke', 'icon', 'icon']);
	assert.match(suggestions[1]!.message, /fontWeight-semiBold/);
	assert.match(suggestions[3]!.message, /circle token for pills/);
	assert.match(suggestions[5]!.message, /var\(--ash-lxiconFontSize\)/);
	assert.match(suggestions[6]!.message, /var\(--ash-lxiconFontSize-compact\)/);
	assert.equal(css.slice(suggestions[0]!.offset, suggestions[0]!.offset + 7), 'padding');
});

test('CLI fails on prohibited selectors but design suggestions are read-only and keep a successful exit', () => {
	mkdirSync(join(root, '.build'), { recursive: true });
	const directory = mkdtempSync(join(root, '.build/stylelint-design-'));
	const file = join(directory, 'component.css');
	try {
		writeFileSync(file, '.a { padding: 5px; font-weight: 500; }');
		const before = readFileSync(file, 'utf8');
		const suggestions = checkStyleSuggestions([file], directory);
		assert.match(suggestions[0]!, /^component\.css:1:6: \[spacing\]/);
		const advisory = spawnSync(process.execPath, ['build/stylelint.ts', file], { cwd: root, encoding: 'utf8' });
		assert.equal(advisory.status, 0, advisory.stderr);
		assert.match(advisory.stderr, /\[spacing\]/);
		assert.match(advisory.stderr, /\[weight\]/);
		assert.equal(readFileSync(file, 'utf8'), before);
		writeFileSync(file, 'body:has(.open) { color: var(--ash-foreground); }');
		const prohibited = spawnSync(process.execPath, ['build/stylelint.ts', file], { cwd: root, encoding: 'utf8' });
		assert.equal(prohibited.status, 1, prohibited.stderr);
		assert.match(prohibited.stderr, /component\.css:1:5: Root-anchored :has/);
	} finally {
		rmSync(directory, { recursive: true });
	}
});
