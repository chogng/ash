import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTestEnvironment } from '../test/automation/testEnvironment.ts';
import { resolveElectronConfiguration } from '../test/automation/electron.ts';

test('ordinary product tests exclude external Codex authentication even when the host sets CODEX_HOME', () => {
	const environment = createTestEnvironment('/isolated-home', {
		HOME: '/host-home',
		CODEX_HOME: '/host-auth',
		PATH: '/bin',
	});
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
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('Electron tests default to memory credentials without preparing a system or temporary keychain', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ash-credential-fixture-'));
	try {
		for (const appServerMode of ['disabled', 'required'] as const) {
			const options = {
				appServerMode,
				userDataDirectory: root,
				packagedBundle: join(root, 'Ash.app'),
				environment: { ...process.env, ASH_USE_INMEMORY_SECRETSTORAGE: '0' },
			};
			const ordinary = resolveElectronConfiguration(options);
			assert.ok(ordinary.args.includes('--use-inmemory-secretstorage'));
			assert.equal(ordinary.env.ASH_USE_INMEMORY_SECRETSTORAGE, undefined);
			assert.equal(ordinary.env.HOME, root);
			const persistence = resolveElectronConfiguration({ ...options, useInMemorySecretStorage: false });
			assert.equal(persistence.args.includes('--use-inmemory-secretstorage'), false);
			for (const launch of [ordinary, persistence]) {
				if (process.platform === 'darwin') assert.ok(launch.args.includes('--use-mock-keychain'));
				if (process.platform === 'linux') assert.ok(launch.args.includes('--password-store=basic'));
			}
		}
		await assert.rejects(stat(join(root, 'Library', 'Keychains')), { code: 'ENOENT' });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
