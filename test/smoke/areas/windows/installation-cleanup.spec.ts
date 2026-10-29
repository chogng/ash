import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { writeInstallationManifest } from '../../../../build/desktop/installationManifest.js';

const run = promisify(execFile);

// This exercises the production Inno script with its real maintenance binary.
// A unique product identity and shortcut name isolate native OS registration;
// unlike release-package, it is also safe on a developer's Windows account.
test('native installer upgrades and removes isolated installations without losing user or shared data', async ({ }, testInfo) => {
	test.skip(process.platform !== 'win32', 'Windows native installer');
	assert(process.env.ISCC_PATH, 'ISCC_PATH must point to the Inno Setup compiler');
	assert(process.env.ASH_INSTALLATION_TEST_DAEMON, 'Build the current ash-app-server-daemon and set ASH_INSTALLATION_TEST_DAEMON');
	const directory = await mkdtemp(join(tmpdir(), 'ash-native-install-'));
	const bundle = join(directory, 'bundle');
	const installation = join(directory, 'installed');
	const registry = join(directory, 'registry');
	const profile = join(directory, 'profile');
	const userData = join(directory, 'electron-data');
	const outside = join(directory, 'shared-component');
	const identity = `com.ash.acceptance.${randomUUID()}`;
	const name = `Ash acceptance ${randomUUID()}`;
	const environment = { ...process.env, ASH_INSTALLATION_REGISTRY: registry, ASH_HOME: profile, ASH_TEST_APP_ID: identity };
	const shortcut = join(process.env.APPDATA!, 'Microsoft/Windows/Start Menu/Programs', `${name}.lnk`);
	const maintenance = join(installation, 'resources/bin/ash-app-server-daemon.exe');
	const command = (exe: string, args: string[]) => run(exe, args, { env: environment, windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
	const compile = async (version: string) => {
		await writeInstallationManifest(bundle);
		await command(process.env.ISCC_PATH!, [
			`/DBundleDir=${bundle}`, `/DAppVersion=${version}`, `/DAppUserId=${identity}`, `/DAppName=${name}`,
			`/DIconPath=${resolve('resources/win32/ash.ico')}`, `/O${directory}`, resolve('build/desktop/win32/ash.iss'),
		]);
		return join(directory, `AshSetup-${version}-win32-x64.exe`);
	};
	const install = (exe: string) => command(exe, ['/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=', `/DIR=${installation}`]);
	const register = (product: string, root: string) => command(maintenance, ['installation', 'register', '--product', product, '--root', root, '--profile', profile, '--user-data', userData]);
	const report = async () => {
		const entry = (await readdir(registry)).find(name => name.startsWith('removal-'));
		return entry ? JSON.parse(await readFile(join(registry, entry), 'utf8')) : undefined;
	};
	const uninstall = async (mode: string) => {
		await command(join(installation, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/ASHDATAMODE=${mode}`, '/ASHLANG=zh']);
		await expect.poll(async () => (await report())?.status, { timeout: 60_000 }).toBe('complete');
	};
	const registered = async () => {
		const result = await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Test-Path -LiteralPath ('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + $env:ASH_TEST_APP_ID + '_is1')"]);
		return result.stdout.trim() === 'True';
	};
	let installed = false;
	try {
		await mkdir(join(bundle, 'resources/bin'), { recursive: true });
		await copyFile(process.env.ASH_INSTALLATION_TEST_DAEMON!, join(bundle, 'resources/bin/ash-app-server-daemon.exe'));
		// Silent fixture installation never launches this product executable.
		await copyFile(process.env.ASH_INSTALLATION_TEST_DAEMON!, join(bundle, 'Ash.exe'));
		// The full application contains platform/workspaces modules. They must be
		// removable only while every byte in this reserved-name tree is owned.
		const modules = 'resources/app/dist/main/platform/workspaces';
		await mkdir(join(bundle, modules), { recursive: true });
		await writeFile(join(bundle, modules, 'module.js'), 'delivered program');
		await writeFile(join(bundle, 'obsolete.txt'), 'previous release');
		await writeFile(join(bundle, 'modified.txt'), 'previous release');
		const previous = await compile('1.0.0');
		await install(previous);
		installed = true;
		assert.equal(await registered(), true);
		assert.equal(await exists(shortcut), true);
		await register('desktop', installation);
		await mkdir(join(profile, 'worktrees/project/.git'), { recursive: true });
		await mkdir(join(profile, 'cache'));
		await mkdir(join(userData, 'Cache'), { recursive: true });
		await mkdir(outside);
		await mkdir(join(profile, 'logs'));
		await writeFile(join(outside, 'important.txt'), 'shared component');
		await symlink(outside, join(profile, 'logs/external'), 'junction');
		await writeFile(join(profile, 'worktrees/project/dirty.txt'), 'user changes');
		await writeFile(join(profile, 'settings.json'), 'settings');
		await writeFile(join(profile, 'cache/download'), 'cached');
		await writeFile(join(userData, 'state.json'), 'electron state');
		await writeFile(join(installation, 'modified.txt'), 'user modified');
		await rm(join(bundle, 'obsolete.txt'));
		await rm(join(bundle, 'modified.txt'));
		const current = await compile('1.0.1');
		await install(current);
		assert.equal(await exists(join(installation, 'obsolete.txt')), false);
		assert.equal(await readFile(join(installation, 'modified.txt'), 'utf8'), 'user modified');
		await uninstall('keep-data');
		installed = false;
		assert.equal(await readFile(join(profile, 'settings.json'), 'utf8'), 'settings');
		assert.equal(await readFile(join(userData, 'state.json'), 'utf8'), 'electron state');
		assert.equal(await exists(join(profile, 'cache')), false);
		assert.equal(await exists(join(installation, 'Ash.exe')), false);
		assert.equal(await exists(shortcut), false);
		assert.equal(await registered(), false);
		await install(current);
		installed = true;
		await register('desktop', installation);
		// Native removal must refuse a redirected installation before Inno gets
		// an opportunity to traverse it or data cleanup modifies the profile.
		const redirected = join(installation, modules, 'external');
		await symlink(outside, redirected, 'junction');
		try {
			await assert.rejects(uninstall('purge'));
			assert.equal(await readFile(join(profile, 'settings.json'), 'utf8'), 'settings');
		} finally { await unlink(redirected); }
		const lease = spawn(maintenance, ['installation', 'lease', '--product', 'desktop', '--root', installation], { env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
		try {
			await new Promise<void>((done, fail) => {
				const timer = setTimeout(() => fail(new Error('Installation lease timed out')), 20_000);
				lease.once('error', error => { clearTimeout(timer); fail(error); });
				lease.stdout.once('data', bytes => { clearTimeout(timer); assert.equal(bytes.toString(), 'ready\n'); done(); });
			});
			await assert.rejects(uninstall('purge'));
			await assert.rejects(install(current));
			assert.equal(await exists(join(installation, 'Ash.exe')), true);
			assert.equal(await readFile(join(profile, 'settings.json'), 'utf8'), 'settings');
		} finally {
			const closed = new Promise<void>(done => lease.once('exit', () => done()));
			lease.stdin.end();
			await closed;
		}
		await uninstall('purge');
		installed = false;
		assert.equal(await exists(join(profile, 'settings.json')), false);
		assert.equal(await exists(join(userData, 'state.json')), false);
		assert.equal(await readFile(join(profile, 'worktrees/project/dirty.txt'), 'utf8'), 'user changes');
		assert.equal(await readFile(join(outside, 'important.txt'), 'utf8'), 'shared component');
		assert.equal(await exists(shortcut), false);
		assert.equal(await registered(), false);
		await testInfo.attach('native-purge-report', { body: JSON.stringify(await report(), null, 2), contentType: 'application/json' });
		await install(current);
		installed = true;
		await register('desktop', installation);
		const shared = join(directory, 'other-cli');
		await mkdir(shared);
		await register('cli', shared);
		await writeFile(join(profile, 'settings.json'), 'shared settings');
		await uninstall('purge');
		installed = false;
		assert.equal(await readFile(join(profile, 'settings.json'), 'utf8'), 'shared settings');
		assert.equal(await readFile(join(profile, 'worktrees/project/dirty.txt'), 'utf8'), 'user changes');
		await testInfo.attach('native-shared-report', { body: JSON.stringify(await report(), null, 2), contentType: 'application/json' });
	} finally {
		// Preserve the fixture for recovery if the native uninstaller itself
		// fails; deleting its files would orphan Windows' uninstall registration.
		if (installed || await exists(join(installation, 'unins000.exe'))) await uninstall('keep-data');
		const absolute = await realpath(directory);
		assert.equal(dirname(absolute), await realpath(tmpdir()));
		assert(basename(absolute).startsWith('ash-native-install-'));
		await rm(absolute, { recursive: true, force: true });
	}
});

async function exists(path: string): Promise<boolean> {
	try { await realpath(path); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
