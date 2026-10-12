import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTestEnvironment } from '../test/automation/testEnvironment.ts';

test('ordinary product tests exclude external Codex authentication even when the host sets CODEX_HOME', () => {
	const environment = createTestEnvironment('/isolated-home', { HOME: '/host-home', CODEX_HOME: '/host-auth', PATH: '/bin' });
	assert.equal(environment.HOME, '/isolated-home');
	assert.equal(environment.CODEX_HOME, undefined);
	assert.equal(environment.CARGO_HOME, join('/host-home', '.cargo'));
});

test('a real-model scenario opts into one canonical auth directory while retaining an isolated product home', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ash-auth-source-'));
	try {
		const environment = createTestEnvironment(join(root, 'isolated'), { HOME: '/host-home', CODEX_HOME: '/unselected-auth' }, root);
		assert.equal(environment.HOME, join(root, 'isolated'));
		assert.equal(environment.CODEX_HOME, await realpath(root));
		assert.throws(() => createTestEnvironment(root, {}, '.'), /absolute/);
		const file = join(root, 'not-a-directory');
		await writeFile(file, 'synthetic fixture');
		assert.throws(() => createTestEnvironment(root, {}, file), /directory/);
		assert.throws(() => createTestEnvironment(root, {}, join(root, 'absent')), /ENOENT/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
