import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTestEnvironment } from '../test/automation/testEnvironment.ts';
import { prepareTestKeychain } from '../test/automation/macKeychain.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

test('macOS Desktop tests retain their own keychain across restarts without changing the host default', { skip: process.platform !== 'darwin' }, async () => {
	const root = await mkdtemp(join(tmpdir(), 'ash-keychain-fixture-'));
	const environment = createTestEnvironment(root, process.env);
	const keychain = join(root, 'Library', 'Keychains', 'ash-smoke.keychain-db');
	const execute = promisify(execFile);
	const defaultKeychain = async (env = process.env) => (await execute('/usr/bin/security', ['default-keychain', '-d', 'user'], { env })).stdout.trim();
	const hostDefault = await defaultKeychain();
	try {
		await prepareTestKeychain(environment);
		assert.equal(await realpath(JSON.parse(await defaultKeychain(environment))), await realpath(keychain));
		const identity = await stat(keychain);
		await prepareTestKeychain(environment);
		assert.equal((await stat(keychain)).ino, identity.ino);
		assert.equal(await defaultKeychain(), hostDefault);
	} finally {
		await execute('/usr/bin/security', ['delete-keychain', keychain], { env: environment }).catch(() => { });
		await rm(root, { recursive: true, force: true });
	}
	assert.equal(await defaultKeychain(), hostDefault);
});
