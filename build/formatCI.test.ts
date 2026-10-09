import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';

function fixture(t: TestContext) {
	const repositoryRoot = resolve(import.meta.dirname, '..');
	mkdirSync(join(repositoryRoot, '.build'), { recursive: true });
	// Keep real formatter dependencies resolvable without installing another copy.
	const root = mkdtempSync(join(repositoryRoot, '.build/format-ci-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const write = (name: string, text: string) => {
		mkdirSync(dirname(join(root, name)), { recursive: true });
		writeFileSync(join(root, name), text);
	};
	for (const file of ['build/ciChanges.ts', 'build/formatCI.ts', 'build/format.ts', 'tsfmt.json', '.prettierrc.toml', '.prettierignore']) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		copyFileSync(join(repositoryRoot, file), join(root, file));
	}
	write('package.json', '{\n  "type": "module"\n}\n');
	write('src/existing.ts', 'const existing=1\n');
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
	git('init', '--initial-branch=main');
	git('config', 'user.name', 'Formatting Test');
	git('config', 'user.email', 'formatting@example.invalid');
	git('add', '.');
	git('commit', '-m', 'Base with unrelated formatting debt');
	const base = git('rev-parse', 'HEAD');
	git('remote', 'add', 'origin', root);
	return {
		root, write, git,
		run: (event = 'pull_request') => {
			git('add', '.');
			git('commit', '--allow-empty', '-m', 'Candidate');
			write('event.json', JSON.stringify({ pull_request: { base: { sha: base } } }, null, 2) + '\n');
			return spawnSync(process.execPath, ['build/formatCI.ts'], { cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: join(root, 'event.json') } });
		},
	};
}

test('a documentation-only PR checks the changed document without unrelated source formatting debt', t => {
	const { write, run } = fixture(t);
	write('docs/file with spaces.md', 'Changed document.\n');
	const result = run();
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /Formatting scope: TS 0; config 1/);
});

test('PR formatting reports changed source and configuration failures without rewriting files', t => {
	const { root, write, run } = fixture(t);
	const source = 'const changed=2\n';
	const config = '{"changed":true}\n';
	write('src/file with spaces.ts', source);
	write('docs/config.json', config);
	const result = run();
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /Formatting scope: TS 1; config 1/);
	assert.match(result.stderr, /File not formatted: src\/file with spaces.ts/);
	assert.match(result.stderr, /docs[\\/]config.json/);
	assert.equal(readFileSync(join(root, 'src/file with spaces.ts'), 'utf8'), source);
	assert.equal(readFileSync(join(root, 'docs/config.json'), 'utf8'), config);
});

test('deleted sources and generated-only changes have an empty formatting scope', t => {
	const { write, git, run } = fixture(t);
	git('rm', 'src/existing.ts');
	write('src/generated/contract.ts', 'generated source');
	write('test/fixtures/contract.json', 'generated configuration');
	const result = run();
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /Formatting scope: TS 0; config 0/);
});

test('formatter settings changes and main acceptance still check all owned sources', t => {
	const { root, write, run } = fixture(t);
	const settings = JSON.parse(readFileSync(join(root, 'tsfmt.json'), 'utf8'));
	write('tsfmt.json', JSON.stringify({ ...settings, indentSize: 3 }, null, 2) + '\n');
	for (const event of ['pull_request', 'push', 'workflow_dispatch']) {
		const result = run(event);
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout, /Formatting scope: TS full/);
		assert.match(result.stderr, /File not formatted: src\/existing.ts/);
	}
});

test('dependency changes check full formatting under the new runtime', t => {
	const { write, run } = fixture(t);
	write('package.json', '{\n  "type": "module",\n  "description": "Changed formatter runtime"\n}\n');
	const result = run();
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.match(result.stdout, /Formatting scope: TS full; config full/);
	assert.match(result.stderr, /File not formatted: src\/existing.ts/);
});
