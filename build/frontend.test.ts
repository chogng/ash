import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

function select(paths: readonly string[], eventName = 'pull_request', surface = 'browser'): { full: boolean; connected: boolean; } {
	const root = mkdtempSync(join(tmpdir(), 'ash-ci-plan-'));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	try {
		mkdirSync(join(root, 'build'));
		copyFileSync(resolve(import.meta.dirname, 'frontend.ts'), join(root, 'build/frontend.ts'));
		copyFileSync(resolve(import.meta.dirname, 'ciChanges.ts'), join(root, 'build/ciChanges.ts'));
		writeFileSync(join(root, 'package.json'), '{"type":"module"}');
		git('init', '--initial-branch=main');
		git('config', 'user.name', 'CI test');
		git('config', 'user.email', 'ci@example.invalid');
		git('add', '.');
		git('commit', '-m', 'base');
		const base = git('rev-parse', 'HEAD');
		git('remote', 'add', 'origin', root);
		for (const file of paths) {
			const path = join(root, file);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, 'changed');
		}
		git('add', '.');
		git('commit', '--allow-empty', '-m', 'candidate');
		const eventPath = join(root, 'event.json');
		writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: base } } }));
		execFileSync(process.execPath, ['build/frontend.ts', 'plan', surface], { cwd: root, stdio: 'pipe', env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: join(root, 'outputs') } });
		return JSON.parse(readFileSync(join(root, '.build/ci/frontend.json'), 'utf8'));
	} finally { rmSync(root, { recursive: true, force: true }); }
}

test('main and manual regression cover both full projects regardless of changed paths', () => {
	for (const event of ['push', 'workflow_dispatch']) {
		for (const surface of ['browser', 'electron']) {
			assert.deepEqual(select(['docs/test.md'], event, surface), { full: true, connected: true });
		}
	}
});

test('CI orchestration and documentation edits retain core smoke without compiling the backend', () => {
	assert.deepEqual(select(['.github/workflows/frontend.yml', 'build/frontend.test.ts', 'docs/test.md']), { full: false, connected: false });
});

test('visual changes retain core smoke and backend-dependent editor changes add Linux connected core', () => {
	assert.deepEqual(select(['src/ash/workbench/contrib/themes/browser/themes.ts', 'src/ash/editor/browser/editor.css']), { full: false, connected: false });
	assert.deepEqual(select(['src/ash/editor/browser/editor.ts']), { full: false, connected: true });
});

test('cross-cutting changes retain the core and require a real backend when applicable', () => {
	assert.deepEqual(select(['src/ash/base/common/event.ts']), { full: false, connected: false });
	assert.deepEqual(select(['crates/app-server/src/lib.rs']), { full: false, connected: true });
});

test('changing peripheral smoke coverage does not expand PR application regression', () => {
	assert.deepEqual(select(['test/smoke/areas/sessions/session.spec.ts']), { full: false, connected: false });
});

test('Rust backend and build changes compile one Linux backend while Electron stays UI-only in PRs', () => {
	const paths = ['crates/app-server/src/lib.rs', 'build/protocol/artifacts.py', 'build/prepare.py'];
	assert.deepEqual(select(paths), { full: false, connected: true });
	assert.deepEqual(select(paths, 'pull_request', 'electron'), { full: false, connected: false });
});

test('TUI and CLI-only changes do not prepare a desktop backend', () => {
	assert.deepEqual(select(['crates/tui/src/app.rs', 'cli/src/main.rs']), { full: false, connected: false });
});
