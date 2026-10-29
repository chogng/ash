import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { planAffectedTests } from './impact.ts';

function fixture(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), 'ash-test-impact-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
	const write = (path: string, text: string): void => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	const commit = (): string => {
		git('add', '--all');
		git('-c', 'user.name=Ash test', '-c', 'user.email=ash-test@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(root, 'no-hooks')}`, 'commit', '-qm', 'test snapshot');
		return git('rev-parse', 'HEAD');
	};
	git('init', '--quiet');
	write('tsconfig.base.json', JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', paths: { 'ash:editor/*': ['./src/*'] } } }));
	write('src/value.ts', 'export const value = 1;');
	write('src/barrel.ts', "export { value } from './value.js';");
	write('src/types.ts', 'export interface Value { value: number; }');
	write('src/test/a.test.ts', "import { value } from '../barrel.js'; void value;");
	write('src/test/b.test.ts', "import type { Value } from '../types.js'; export type T = Value;");
	write('src/test/c.test.ts', 'export {};');
	write('src/test/d.test.ts', 'export {};');
	write('src/test/e.test.ts', 'export {};');
	write('test/architecture/ownership.test.ts', 'export {};');
	const tests = ['a', 'b', 'c', 'd', 'e'].map(name => `src/test/${name}.test.js`).concat('test/architecture/ownership.test.js');
	const base = commit();
	return { root, git, write, commit, tests, base };
}

test('follows re-exports and keeps architecture checks when a local implementation changes', t => {
	const f = fixture(t);
	f.write('src/value.ts', 'export const value = 2;');
	assert.deepEqual(planAffectedTests(f.root, f.base, f.tests).files, ['src/test/a.test.js', 'test/architecture/ownership.test.js']);
	assert.equal(planAffectedTests(f.root, f.base, f.tests).full, false);
});

test('includes type-only dependencies instead of assuming type edits are irrelevant', t => {
	const f = fixture(t);
	f.write('src/types.ts', 'export interface Value { value: string; }');
	assert.deepEqual(planAffectedTests(f.root, f.base, f.tests).files, ['src/test/b.test.js', 'test/architecture/ownership.test.js']);
});

test('new untracked test files participate in local selection', t => {
	const f = fixture(t);
	f.write('src/test/new.test.ts', 'export const added = true;');
	const tests = [...f.tests, 'src/test/new.test.js'];
	assert.deepEqual(planAffectedTests(f.root, f.base, tests).files, ['test/architecture/ownership.test.js', 'src/test/new.test.js']);
	assert.match(f.git('status', '--porcelain'), /^\?\? src\/test\/new.test.ts$/u);
});

test('uses both source graphs when an implementation is renamed and its import is retargeted', t => {
	const f = fixture(t);
	renameSync(join(f.root, 'src/value.ts'), join(f.root, 'src/renamed.ts'));
	f.write('src/barrel.ts', "export { value } from './renamed.js';");
	assert.deepEqual(planAffectedTests(f.root, f.base, f.tests).files, ['src/test/a.test.js', 'test/architecture/ownership.test.js']);
});

test('resolves configured aliases and CSS dependencies', t => {
	const f = fixture(t);
	f.write('src/test/a.test.ts', "import { value } from 'ash:editor/value.js'; void value; import '../style.css';");
	f.write('src/style.css', '.widget { color: red; }');
	const base = f.commit();
	for (const [path, text] of [['src/value.ts', 'export const value = 2;'], ['src/style.css', '.widget { color: blue; }']]) {
		f.write(path, text);
		const plan = planAffectedTests(f.root, base, f.tests);
		assert.equal(plan.full, false, `${path}: ${plan.reason}`);
		assert.deepEqual(plan.files, ['src/test/a.test.js', 'test/architecture/ownership.test.js']);
		f.git('restore', '--', path);
	}
});

test('unknown inputs, filesystem-only fixtures and dependency changes retain the full suite', t => {
	for (const path of ['pnpm-lock.yaml', 'extensions/example/package.json', 'test/unit/editor-environment.ts', '.github/workflows/frontend.yml', 'src/test/fixtures/data.json', 'src/unknown.ts']) {
		const f = fixture(t);
		f.write(path, 'changed');
		const plan = planAffectedTests(f.root, f.base, f.tests);
		assert.equal(plan.full, true, path);
		assert.deepEqual(plan.files, f.tests);
	}
});

test('a large selection and an unchanged tree retain the full suite', t => {
	const f = fixture(t);
	assert.equal(planAffectedTests(f.root, f.base, f.tests).full, true);
	for (const name of ['a', 'b', 'c', 'd']) f.write(`src/test/${name}.test.ts`, `export const ${name} = true;`);
	const plan = planAffectedTests(f.root, f.base, f.tests);
	assert.equal(plan.full, true);
	assert.match(plan.reason, /more than half/u);
});

test('retains filesystem readers, computed imports and rendered fixtures outside static import edges', t => {
	for (const source of [
		"import { readFileSync } from 'node:fs'; export const read = readFileSync;",
		'export const load = (path: string) => import(path);',
		"import '../../test/unit/browser/context.js';",
	]) {
		const f = fixture(t);
		f.write('src/test/c.test.ts', source);
		f.write('test/unit/browser/context.ts', 'export {};');
		const base = f.commit();
		f.write('src/value.ts', 'export const value = 2;');
		assert.deepEqual(planAffectedTests(f.root, base, f.tests).files, ['src/test/a.test.js', 'src/test/c.test.js', 'test/architecture/ownership.test.js']);
	}
});

test('changes to a dynamically loaded shared preload dependency run every test', t => {
	const f = fixture(t);
	f.write('src/ash/platform/service.ts', 'export const value = 1;');
	f.write('src/test/a.test.ts', "import { value } from '../ash/platform/service.js'; void value;");
	f.write('test/unit/theme-resources.ts', "const output = ''; await import(resolve(output, 'platform/service.js'));");
	const base = f.commit();
	f.write('src/ash/platform/service.ts', 'export const value = 2;');
	const plan = planAffectedTests(f.root, base, f.tests, { preloads: ['test/unit/theme-resources.ts'] });
	assert.equal(plan.full, true);
	assert.match(plan.reason, /shared test preload/u);
});

test('invalid base revisions fail explicitly and cannot become Git options', t => {
	const f = fixture(t);
	for (const base of ['missing-revision', '--help']) assert.throws(() => planAffectedTests(f.root, base, f.tests));
});

test('historical planning does not mix in worktree changes or rewrite the checkout', t => {
	const f = fixture(t);
	f.write('src/value.ts', 'export const value = 2;');
	const head = f.commit();
	f.write('pnpm-lock.yaml', 'uncommitted dependency update');
	const status = f.git('status', '--porcelain');
	assert.equal(planAffectedTests(f.root, f.base, f.tests).full, true);
	assert.deepEqual(planAffectedTests(f.root, f.base, f.tests, { head }).files, ['src/test/a.test.js', 'test/architecture/ownership.test.js']);
	assert.equal(f.git('status', '--porcelain'), status);
	assert.equal(f.git('rev-parse', 'HEAD'), head);
});
