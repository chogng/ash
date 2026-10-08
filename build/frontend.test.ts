import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const specs = ['editor/edit.spec.ts', 'sessions/session.spec.ts', 'windows/quickaccess.spec.ts', 'windows/themes.spec.ts'];

function select(paths: readonly string[], eventName = 'pull_request'): { full: boolean; connected: boolean; files: string[]; } {
	const root = mkdtempSync(join(tmpdir(), 'ash-ci-plan-'));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	try {
		mkdirSync(join(root, 'build'));
		copyFileSync(resolve(import.meta.dirname, 'frontend.ts'), join(root, 'build/frontend.ts'));
		writeFileSync(join(root, 'package.json'), '{"type":"module"}');
		for (const file of specs) {
			const path = join(root, 'test/smoke/areas', file);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, 'smoke fixture');
		}
		git('init');
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
		execFileSync(process.execPath, ['build/frontend.ts', 'plan'], { cwd: root, stdio: 'pipe', env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: join(root, 'outputs') } });
		return JSON.parse(readFileSync(join(root, '.build/ci/frontend.json'), 'utf8'));
	} finally { rmSync(root, { recursive: true, force: true }); }
}

test('main and manual regression cover both full projects regardless of changed paths', () => {
	for (const event of ['push', 'workflow_dispatch']) {
		assert.deepEqual(select(['docs/test.md'], event), { full: true, connected: true, files: [] });
	}
});

test('CI orchestration and documentation edits retain core smoke without compiling the backend', () => {
	assert.deepEqual(select(['.github/workflows/frontend.yml', 'build/frontend.test.ts', 'build/protocol/artifacts.py', 'docs/test.md']), { full: false, connected: false, files: [] });
});

test('a UI feature selects its area while a backend-dependent editor selects real connected tests', () => {
	assert.deepEqual(select(['src/ash/workbench/contrib/themes/browser/themes.ts']), { full: false, connected: false, files: ['test/smoke/areas/windows/themes.spec.ts'] });
	assert.deepEqual(select(['src/ash/editor/browser/editor.ts']), { full: false, connected: true, files: ['test/smoke/areas/editor/edit.spec.ts'] });
});

test('cross-cutting changes retain the core and require a real backend when applicable', () => {
	assert.deepEqual(select(['src/ash/base/common/event.ts']), { full: false, connected: false, files: [] });
	assert.deepEqual(select(['crates/app-server/src/lib.rs']), { full: false, connected: true, files: [] });
});

test('a changed smoke test runs that file with both backend modes', () => {
	assert.deepEqual(select(['test/smoke/areas/sessions/session.spec.ts']), { full: false, connected: true, files: ['test/smoke/areas/sessions/session.spec.ts'] });
});
