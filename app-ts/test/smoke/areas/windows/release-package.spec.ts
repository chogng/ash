import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { exercisePackagedWorkbench } from '../../../automation/packagedWorkbench.js';

const run = promisify(execFile);

test('release installation runs its bundled backend, upgrades with retained data and uninstalls', async ({}, testInfo) => {
	assert(['win32', 'darwin'].includes(process.platform), 'Desktop release requires Windows or macOS');
	const archive = resolve(required('ASH_RELEASE_ARCHIVE'));
	const version = required('ASH_RELEASE_VERSION');
	const previousArchive = process.env.ASH_RELEASE_PREVIOUS_ARCHIVE;
	const previousVersion = process.env.ASH_RELEASE_PREVIOUS_VERSION;
	assert.equal(Boolean(previousArchive), Boolean(previousVersion), 'Upgrade requires both previous archive and version');
	// Installers write the per-user application registration. Run only on disposable CI hosts.
	if (process.platform === 'win32') assert.equal(process.env.CI, 'true', 'Windows installer sanity requires a disposable CI host');
	const directory = await mkdtemp(join(tmpdir(), 'ash-release-'));
	const installation = join(directory, 'installed');
	const userData = await mkdtemp(join(tmpdir(), 'ash-'));
	const workspace = join(directory, 'workspace');
	const settingsPath = join(userData, 'profile', 'settings.json');
	const file = join(workspace, 'main.ts');
	let installed = false;
	try {
		await mkdir(workspace);
		await mkdir(join(userData, 'profile'), { recursive: true });
		await writeFile(settingsPath, JSON.stringify({ 'update.policy': 'never', 'editor.fontSize': 17 }));
		await writeFile(file, 'const release = 1;\n');
		if (previousArchive) {
			await install(resolve(previousArchive), installation);
			installed = true;
			await exercisePackagedWorkbench(installation, previousVersion!, userData, workspace, 'const release = 2;', testInfo, 'previous');
			await expect.poll(async () => JSON.parse(await readFile(settingsPath, 'utf8'))['editor.fontSize']).toBe(17);
			assert.equal(await readFile(file, 'utf8'), 'const release = 2;');
		}
		await install(archive, installation);
		installed = true;
		assert.equal(await readFile(file, 'utf8'), previousArchive ? 'const release = 2;' : 'const release = 1;\n');
		assert.equal(JSON.parse(await readFile(settingsPath, 'utf8'))['editor.fontSize'], 17);
		await exercisePackagedWorkbench(installation, version, userData, workspace, 'const release = 3;', testInfo, 'candidate');
		// Reopen the delivered executable with the same state after the upgrade.
		await exercisePackagedWorkbench(installation, version, userData, workspace, 'const release = 4;', testInfo, 'restart');
		assert.equal(JSON.parse(await readFile(settingsPath, 'utf8'))['editor.fontSize'], 17);
		await uninstall(installation, directory);
		installed = false;
		await expect.poll(() => exists(installation)).toBe(false);
		assert.equal(await readFile(file, 'utf8'), 'const release = 4;');
		assert.equal(JSON.parse(await readFile(settingsPath, 'utf8'))['editor.fontSize'], 17);
	} finally {
		try {
			if (installed) await uninstall(installation, directory);
		} finally {
			await removeInstallation(directory, await realpath(tmpdir()), 'ash-release-');
			await removeInstallation(userData, await realpath(tmpdir()), 'ash-');
		}
	}
});

function required(name: string): string {
	const value = process.env[name];
	assert(value, `${name} is required; run the release sanity entrypoint`);
	return value;
}
async function exists(path: string): Promise<boolean> {
	try { await realpath(path); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function install(archive: string, installation: string): Promise<void> {
	if (process.platform === 'win32') {
		await run(archive, ['/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/NORESTARTAPPLICATIONS', `/DIR=${installation}`, '/TASKS='], { windowsHide: true, timeout: 300_000 });
	} else {
		// A macOS ZIP is installed by extracting Ash.app; remove old bundle files so deleted files cannot survive an upgrade.
		if (await exists(installation)) await removeInstallation(installation, await realpath(dirname(installation)), 'installed');
		await mkdir(installation);
		await run('ditto', ['-x', '-k', archive, installation], { timeout: 300_000 });
		const bundle = join(installation, 'Ash.app');
		await run('codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 120_000 });
		await run('spctl', ['--assess', '--type', 'execute', bundle], { timeout: 120_000 });
		await run('xcrun', ['stapler', 'validate', bundle], { timeout: 120_000 });
	}
}

async function uninstall(installation: string, directory: string): Promise<void> {
	if (process.platform === 'win32') await run(join(installation, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { windowsHide: true, timeout: 120_000 });
	else await removeInstallation(installation, await realpath(directory), 'installed');
}

async function removeInstallation(path: string, parent: string, prefix: string): Promise<void> {
	if (!await exists(path)) return;
	const absolute = await realpath(path);
	assert.equal(dirname(absolute), parent, 'Installation cleanup must stay in the test directory');
	assert(basename(absolute).startsWith(prefix));
	await rm(absolute, { recursive: true, force: true });
}
