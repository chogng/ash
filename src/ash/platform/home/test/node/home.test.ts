import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'mocha';
import { resolveHome } from '../../node/home.js';

test('explicit and default home resolve to the same physical directory', async () => {
	const user = await mkdtemp(join(tmpdir(), 'ash-home-'));
	try {
		const path = join(user, '.ash');
		await mkdir(path);
		assert.equal(resolveHome({ environment: {}, userHome: user }), realpathSync.native(path));
		assert.equal(resolveHome({ environment: { ASH_HOME: path }, userHome: '' }), realpathSync.native(path));
	} finally {
		await rm(user, { recursive: true, force: true });
	}
});

test('a missing home is resolved without creating directories', async () => {
	const user = await mkdtemp(join(tmpdir(), 'ash-home-'));
	try {
		const path = join(user, 'new', 'data');
		assert.equal(resolveHome({ environment: { ASH_HOME: path }, userHome: '' }), join(realpathSync.native(user), 'new', 'data'));
		assert.equal(resolveHome({ environment: {}, userHome: user }), join(realpathSync.native(user), '.ash'));
		assert.equal(existsSync(path), false);
	} finally {
		await rm(user, { recursive: true, force: true });
	}
});

test('invalid home overrides and missing user homes fail without selecting another root', async () => {
	const user = await mkdtemp(join(tmpdir(), 'ash-home-'));
	try {
		for (const path of ['', 'relative']) {
			assert.throws(() => resolveHome({ environment: { ASH_HOME: path }, userHome: user }), /absolute/);
		}
		for (const userHome of ['', 'relative']) {
			assert.throws(() => resolveHome({ environment: {}, userHome }), /user home/);
		}
		const file = join(user, 'file');
		await writeFile(file, 'keep');
		assert.throws(() => resolveHome({ environment: { ASH_HOME: file }, userHome: user }), /not a directory/);
		assert.throws(() => resolveHome({ environment: { ASH_HOME: join(file, 'data') }, userHome: user }));
		assert.equal(await readFile(file, 'utf8'), 'keep');
	} finally {
		await rm(user, { recursive: true, force: true });
	}
});

test('retired home overrides require migration even when both variables agree', () => {
	for (const configured of [undefined, tmpdir()]) {
		assert.throws(() => resolveHome({ environment: { ASH_PROFILE_ROOT: tmpdir(), ASH_HOME: configured }, userHome: tmpdir() }), /remove ASH_PROFILE_ROOT/);
	}
});

test('Windows homes require a drive or a complete UNC root', function () {
	if (process.platform !== 'win32') this.skip();
	for (const path of ['\\folder', '/folder', 'C:folder', '\\\\server']) {
		assert.throws(() => resolveHome({ environment: { ASH_HOME: path }, userHome: tmpdir() }), /absolute/);
	}
});

test('home resolves directory aliases and rejects dangling links', async function () {
	if (process.platform === 'win32') this.skip();
	const user = await mkdtemp(join(tmpdir(), 'ash-home-'));
	try {
		const real = join(user, 'real');
		await mkdir(real);
		const alias = join(user, 'alias');
		await symlink(real, alias);
		assert.equal(resolveHome({ environment: { ASH_HOME: join(alias, 'new') }, userHome: '' }), join(realpathSync.native(real), 'new'));
		const dangling = join(user, 'dangling');
		await symlink(join(user, 'missing'), dangling);
		assert.throws(() => resolveHome({ environment: { ASH_HOME: dangling }, userHome: '' }));
		assert.throws(() => resolveHome({ environment: { ASH_HOME: join(dangling, 'new') }, userHome: '' }));
	} finally {
		await rm(user, { recursive: true, force: true });
	}
});
