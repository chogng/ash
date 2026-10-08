import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

function checkout(t: TestContext) {
	const root = mkdtempSync(join(tmpdir(), 'ash-hook-install-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, 'build'));
	copyFileSync(join(import.meta.dirname, 'gitHooks.ts'), join(root, 'build', 'gitHooks.ts'));
	const config = join(root, 'empty-gitconfig');
	writeFileSync(config, '');
	// Device-global configuration must not alter the isolated checkout fixture.
	const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config };
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
	git('init', '--initial-branch=main');
	return { git, run: (ci: string, ...args: string[]) => spawnSync(process.execPath, ['build/gitHooks.ts', ...args], { cwd: root, env: { ...env, CI: ci }, encoding: 'utf8' }) };
}

test('dependency preparation installs hooks in a fresh checkout and can run again', t => {
	const { git, run } = checkout(t);
	assert.equal(run('').status, 0);
	assert.equal(git('config', '--local', '--get', 'core.hooksPath').trim(), '.githooks');
	assert.equal(run('').status, 0);
});

test('CI preparation preserves hook configuration while explicit installation remains available', t => {
	const { git, run } = checkout(t);
	assert.equal(run('true').status, 0);
	assert.equal(git('config', '--local', '--list').includes('core.hookspath'), false);
	assert.equal(run('true', '--install').status, 0);
	assert.equal(git('config', '--local', '--get', 'core.hooksPath').trim(), '.githooks');
});

test('automatic preparation preserves custom hooks without blocking dependency installation', t => {
	const { git, run } = checkout(t);
	git('config', '--local', 'core.hooksPath', 'custom hooks');
	const automatic = run('');
	assert.equal(automatic.status, 0);
	assert.match(automatic.stderr, /Existing Git hooks at custom hooks/);
	assert.equal(git('config', '--local', '--get', 'core.hooksPath').trim(), 'custom hooks');
	assert.notEqual(run('', '--install').status, 0);
	assert.equal(git('config', '--local', '--get', 'core.hooksPath').trim(), 'custom hooks');
});
