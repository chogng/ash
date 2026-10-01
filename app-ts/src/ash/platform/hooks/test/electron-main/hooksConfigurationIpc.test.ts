import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'mocha';
import { hooksConfigurationIpcRoute } from '../../electron-main/hooksConfigurationIpc.js';

test('Hooks editing creates only the host profile TOML and preserves its existing contents', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ash-hooks-'));
	try {
		const opened: string[] = [];
		const route = hooksConfigurationIpcRoute(root, () => true, async path => { opened.push(path); });
		assert.throws(() => route.validate({ path: '/arbitrary/config.toml' }), /no arguments/);
		await route.invoke(route.validate(undefined));
		const path = join(root, 'config.toml');
		assert.equal(await readFile(path, 'utf8'), '');
		const contents = '# Preserve comments and unrelated settings\nschemaVersion = 1\n';
		await writeFile(path, contents);
		await route.invoke(undefined);
		assert.deepEqual(opened, [path, path]);
		assert.equal(await readFile(path, 'utf8'), contents);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('A remote connection cannot open or create the local profile Hooks TOML', async () => {
	const root = await mkdtemp(join(tmpdir(), 'ash-hooks-remote-'));
	try {
		let local = true;
		let opens = 0;
		const path = join(root, 'new-profile');
		const route = hooksConfigurationIpcRoute(path, () => local, async () => { opens++; });
		local = false;
		await assert.rejects(async () => { await route.invoke(undefined); }, /remote host/);
		await assert.rejects(stat(path), { code: 'ENOENT' });
		assert.equal(opens, 0);
	} finally { await rm(root, { recursive: true, force: true }); }
});
