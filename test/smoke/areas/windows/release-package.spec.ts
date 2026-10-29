import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { exercisePackagedWorkbench } from '../../../automation/packagedWorkbench.js';

const run = promisify(execFile);

test('release installation runs its bundled backend, upgrades with retained data and uninstalls', async ({ }, testInfo) => {
	assert(['win32', 'darwin'].includes(process.platform), 'Desktop release requires Windows or macOS');
	const archive = resolve(required('ASH_RELEASE_ARCHIVE'));
	const version = required('ASH_RELEASE_VERSION');
	const previousArchive = process.env.ASH_RELEASE_PREVIOUS_ARCHIVE;
	const previousVersion = process.env.ASH_RELEASE_PREVIOUS_VERSION;
	assert.equal(Boolean(previousArchive), Boolean(previousVersion), 'Upgrade requires both previous archive and version');
	// Installers write the per-user application registration. Run only on disposable CI hosts.
	if (process.platform === 'win32') assert.equal(process.env.CI, 'true', 'Windows installer sanity requires a disposable CI host');
	// Keep the canonical Windows profile socket below AF_UNIX's 108-byte limit.
	const directory = await mkdtemp(join(tmpdir(), 'ash-r-'));
	const installation = join(directory, 'installed');
	const userData = join(directory, 'Ash');
	const workspace = join(directory, 'workspace');
	const settingsPath = join(userData, 'profile', 'settings.json');
	const keybindingsPath = join(userData, 'profile', 'keybindings.json');
	const retainedData = [
		[join(userData, 'profile', 'state', 'cloud-codebase', 'acceptance.txt'), 'cloud state'],
		[join(userData, 'profile', 'ash-code', 'themes', 'acceptance.txt'), 'terminal appearance'],
	] as const;
	const file = join(workspace, 'main.ts');
	let installed = false;
	let failure: unknown;
	try {
		await mkdir(workspace);
		await install(resolve(previousArchive ?? archive), installation, userData);
		installed = true;
		assert(!await exists(userData), 'Installation must record ownership without creating application data');
		await mkdir(join(userData, 'profile'), { recursive: true });
		await writeFile(settingsPath, JSON.stringify({ 'update.policy': 'never', 'editor.fontSize': 17 }));
		await writeFile(keybindingsPath, '[]');
		for (const [path, contents] of retainedData) {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, contents);
		}
		await writeFile(file, 'const release = 1;\n');
		if (previousArchive) {
			await exercisePackagedWorkbench(installation, previousVersion!, userData, workspace, 'const release = 2;', testInfo, 'previous', workbenchEnvironment(userData));
			await expect.poll(async () => JSON.parse(await readFile(settingsPath, 'utf8'))['editor.fontSize']).toBe(17);
			assert.equal(await readFile(file, 'utf8'), 'const release = 2;');
			if (process.platform === 'win32' && previousVersion === '0.0.0') assert(await exists(join(installation, 'upgrade-retired.txt')));
		}
		await install(archive, installation, userData);
		installed = true;
		assert(!await exists(join(installation, 'upgrade-retired.txt')));
		assert.equal(await readFile(file, 'utf8'), previousArchive ? 'const release = 2;' : 'const release = 1;\n');
		assert.equal(JSON.parse(await readFile(settingsPath, 'utf8'))['editor.fontSize'], 17);
		assert.equal(await readFile(keybindingsPath, 'utf8'), '[]');
		await exercisePackagedWorkbench(installation, version, userData, workspace, 'const release = 3;', testInfo, 'candidate', workbenchEnvironment(userData));
		// Reopen the delivered executable with the same state after the upgrade.
		await exercisePackagedWorkbench(installation, version, userData, workspace, 'const release = 4;', testInfo, 'restart', workbenchEnvironment(userData));
		assert.equal(JSON.parse(await readFile(settingsPath, 'utf8'))['editor.fontSize'], 17);
		await uninstall(installation, directory, userData);
		installed = false;
		await expect.poll(() => exists(installation)).toBe(false);
		assert.equal(await readFile(file, 'utf8'), 'const release = 4;');
		assert.equal(JSON.parse(await readFile(settingsPath, 'utf8'))['editor.fontSize'], 17);
		if (process.platform === 'win32') {
			for (const [path, contents] of retainedData) assert.equal(await readFile(path, 'utf8'), contents);
			assert.equal(await readFile(keybindingsPath, 'utf8'), '[]');
			await attachRemovalReport(userData, testInfo, 'keep-data-report');
			await assertNoNativeResidue(installation);
			await install(archive, installation, userData);
			installed = true;
			await exercisePackagedWorkbench(installation, version, userData, workspace, 'const release = 6;', testInfo, 'reinstall', workbenchEnvironment(userData));
			assert.equal(JSON.parse(await readFile(settingsPath, 'utf8'))['editor.fontSize'], 17);
			await uninstall(installation, directory, userData, 'purge');
			installed = false;
			assert(!await exists(settingsPath));
			assert.equal(await readFile(file, 'utf8'), 'const release = 6;');
			await expect.poll(() => exists(installation)).toBe(false);
			await attachRemovalReport(userData, testInfo, 'reinstall-purge-report');
			assert(!await exists(userData), 'An exclusively owned profile must leave no application data after purge');
			await assertNoNativeResidue(installation);
		}
	} catch (error) {
		failure = error;
		throw error;
	} finally {
		try {
			if (installed) await uninstall(installation, directory, userData);
			await removeInstallation(directory, await realpath(tmpdir()), 'ash-r-');
		} catch (cleanup) {
			if (failure) throw new Error(`Release acceptance failed: ${String(failure)}\nCleanup also failed: ${String(cleanup)}`, { cause: failure });
			throw cleanup;
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

async function install(archive: string, installation: string, userData: string): Promise<void> {
	if (process.platform === 'win32') {
		await run(archive, ['/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/NORESTARTAPPLICATIONS', `/DIR=${installation}`, '/TASKS='], { windowsHide: true, timeout: 300_000, env: installationEnvironment(userData) });
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

async function uninstall(installation: string, directory: string, userData: string, mode = 'keep-data'): Promise<void> {
	if (process.platform === 'win32') {
		try {
			await run(join(installation, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/ASHDATAMODE=${mode}`, '/ASHLANG=zh'], { windowsHide: true, timeout: 120_000, env: installationEnvironment(userData) });
			// Inno's first process can exit before its temporary worker finishes the
			// post-uninstall hook. The persisted report is the completion boundary.
			await expect.poll(async () => (await readRemovalReport(userData))?.status ?? 'missing', { timeout: 60_000 }).toBe('complete');
		} catch (error) {
			const report = await readRemovalReport(userData);
			throw new Error(`Native uninstall failed: ${JSON.stringify({ status: report?.status, report: report?.report })}`, { cause: error });
		}
	}
	else await removeInstallation(installation, await realpath(directory), 'installed');
}

function workbenchEnvironment(userData: string) {
	return { environment: installationEnvironment(userData), homeDirectory: join(dirname(userData), 'home') };
}

function installationEnvironment(userData: string): NodeJS.ProcessEnv {
	return { ...process.env, APPDATA: dirname(userData), ASH_HOME: join(userData, 'profile'), ASH_INSTALLATION_REGISTRY: installationRegistry(userData) };
}

function installationRegistry(userData: string): string {
	return join(dirname(userData), `${basename(userData)}-installation-registry`);
}

async function attachRemovalReport(userData: string, testInfo: import('@playwright/test').TestInfo, name: string): Promise<void> {
	const report = await readRemovalReport(userData);
	assert(report, 'The native uninstaller must publish a removal report');
	assert.equal(report.status, 'complete');
	assert.deepEqual(report.report.failures, []);
	await testInfo.attach(name, { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
}

async function readRemovalReport(userData: string) {
	const registry = installationRegistry(userData);
	const reports = await readdir(registry);
	const name = reports.find(name => name.startsWith('removal-') && name.endsWith('.json'));
	return name ? JSON.parse(await readFile(join(registry, name), 'utf8')) : undefined;
}

async function assertNoNativeResidue(installation: string): Promise<void> {
	const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; $root=$env:ASH_TEST_INSTALL.TrimEnd('\\'); $registrations=@(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | Get-ItemProperty | Where-Object { $_.InstallLocation -and $_.InstallLocation.TrimEnd('\\') -eq $root }); $processes=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root + '\\',[StringComparison]::OrdinalIgnoreCase) }); @{registered=$registrations.Count;processes=$processes.Count;shortcut=(Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'Ash.lnk'))} | ConvertTo-Json -Compress"], { windowsHide: true, env: { ...process.env, ASH_TEST_INSTALL: installation } });
	assert.deepEqual(JSON.parse(result.stdout), { registered: 0, processes: 0, shortcut: false });
}

test('Windows upgrade and purge protect worktrees, junctions and another product, and reclaim owned system entries', async ({ }, testInfo) => {
	test.skip(process.platform !== 'win32', 'Windows native installer contract');
	assert.equal(process.env.CI, 'true', 'System cleanup acceptance requires a disposable CI host');
	const archive = resolve(required('ASH_RELEASE_ARCHIVE'));
	for (const shared of [false, true]) {
		const directory = await mkdtemp(join(tmpdir(), 'ash-c-'));
		const installation = join(directory, 'installed');
		const userData = join(directory, 'Ash');
		const profile = join(userData, 'profile');
		const workspace = join(profile, 'worktrees', 'project');
		const outside = join(directory, 'shared-files');
		const ownedRule = `TCP Query User${randomUUID()}`;
		const sharedRule = `TCP Query User${randomUUID()}`;
		let installed = false;
		let failure: unknown;
		const shell = (script: string) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
			windowsHide: true, timeout: 60_000,
			env: { ...installationEnvironment(userData), ASH_TEST_INSTALL: installation, ASH_TEST_OUTSIDE: outside, ASH_TEST_OWNED_RULE: ownedRule, ASH_TEST_SHARED_RULE: sharedRule },
		});
		try {
			await install(archive, installation, userData);
			installed = true;
			const maintenance = join(installation, 'resources', 'bin', 'ash-app-server-daemon.exe');
			const register = async (product: string, root: string) => run(maintenance, ['installation', 'register', '--product', product, '--root', root, '--profile', profile, '--user-data', userData], { windowsHide: true, env: installationEnvironment(userData) });
			assert(!await exists(userData), 'The native installer must register the fresh profile before launch');
			if (shared) {
				const other = join(directory, 'other-cli');
				await mkdir(other);
				await register('cli', other);
			}
			await mkdir(workspace, { recursive: true });
			await run('git', ['init', '--quiet', workspace], { windowsHide: true });
			await mkdir(join(profile, 'cache'));
			await mkdir(join(profile, 'logs'));
			await mkdir(outside);
			await writeFile(join(workspace, 'main.ts'), 'const release = 0;');
			await writeFile(join(outside, 'important.txt'), 'shared component');
			await symlink(outside, join(profile, 'logs', 'external'), 'junction');
			await writeFile(join(profile, 'cache', 'download'), 'cached');
			await writeFile(join(profile, 'settings.json'), JSON.stringify({ 'update.policy': 'never', 'editor.fontSize': 17 }));
			const manifestPath = join(installation, 'resources', 'installation-files.json');
			const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
			for (const name of ['obsolete.txt', 'modified.txt']) {
				await writeFile(join(installation, name), 'old release');
				manifest.files[name] = createHash('sha256').update('old release').digest('hex');
			}
			await writeFile(manifestPath, JSON.stringify(manifest));
			await writeFile(join(installation, 'modified.txt'), 'user changed this');
			await install(archive, installation, userData);
			assert(!await exists(join(installation, 'obsolete.txt')));
			assert.equal(await readFile(join(installation, 'modified.txt'), 'utf8'), 'user changed this');
			await exercisePackagedWorkbench(installation, required('ASH_RELEASE_VERSION'), userData, workspace, 'const release = 5;', testInfo, shared ? 'shared' : 'purge', workbenchEnvironment(userData));
			await writeFile(join(userData, 'state.json'), JSON.stringify({ installationAcceptance: true }));
			const lease = spawn(maintenance, ['installation', 'lease', '--product', 'desktop', '--root', installation], { windowsHide: true, env: installationEnvironment(userData), stdio: ['pipe', 'pipe', 'pipe'] });
			try {
				await new Promise<void>((done, fail) => {
					const timer = setTimeout(() => fail(new Error('Installation lease did not become ready')), 20_000);
					lease.once('error', error => { clearTimeout(timer); fail(error); });
					lease.stdout.once('data', chunk => { clearTimeout(timer); assert.equal(chunk.toString(), 'ready\n'); done(); });
				});
				await assert.rejects(uninstall(installation, directory, userData, 'purge'));
				assert(await exists(join(installation, 'Ash.exe')));
				assert(await exists(join(profile, 'settings.json')));
			} finally {
				const closed = new Promise<void>(done => lease.once('exit', () => done()));
				lease.stdin.end();
				await closed;
			}
			await shell("$ErrorActionPreference='Stop'; New-NetFirewallRule -Name $env:ASH_TEST_OWNED_RULE -DisplayName 'Ash cleanup fixture' -Direction Inbound -Action Allow -Program (Join-Path $env:ASH_TEST_INSTALL 'Ash.exe') | Out-Null; New-NetFirewallRule -Name $env:ASH_TEST_SHARED_RULE -DisplayName 'Ash shared fixture' -Direction Inbound -Action Allow -Program (Join-Path $env:ASH_TEST_OUTSIDE 'Ash.exe') | Out-Null");
			await uninstall(installation, directory, userData, 'purge');
			installed = false;
			assert(!await exists(join(installation, 'Ash.exe')));
			assert.equal(await exists(join(profile, 'settings.json')), shared);
			assert.equal(await exists(join(profile, 'cache', 'download')), shared);
			assert.equal(await exists(join(userData, 'state.json')), shared);
			assert.equal(await readFile(join(workspace, 'main.ts'), 'utf8'), 'const release = 5;');
			assert.equal(await readFile(join(outside, 'important.txt'), 'utf8'), 'shared component');
			assert.equal(await readFile(join(installation, 'modified.txt'), 'utf8'), 'user changed this');
			const inventory = await shell("$ErrorActionPreference='Stop'; $registered=@(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | Get-ItemProperty | Where-Object { $_.InstallLocation -and $_.InstallLocation.TrimEnd('\\') -eq $env:ASH_TEST_INSTALL }); @{owned=@(Get-NetFirewallRule -Name $env:ASH_TEST_OWNED_RULE -ErrorAction SilentlyContinue).Count;shared=@(Get-NetFirewallRule -Name $env:ASH_TEST_SHARED_RULE -ErrorAction SilentlyContinue).Count;registered=$registered.Count} | ConvertTo-Json -Compress");
			assert.deepEqual(JSON.parse(inventory.stdout), { owned: 0, shared: 1, registered: 0 });
			await attachRemovalReport(userData, testInfo, shared ? 'shared-removal-report' : 'purge-removal-report');
			if (!shared) {
				assert.deepEqual(await readdir(userData), ['profile']);
				assert.deepEqual((await readdir(profile)).sort(), ['logs', 'worktrees']);
			}
			await assertNoNativeResidue(installation);
		} catch (error) {
			failure = error;
			throw error;
		} finally {
			try {
				if (installed) await uninstall(installation, directory, userData);
				await shell("Get-NetFirewallRule -Name $env:ASH_TEST_OWNED_RULE,$env:ASH_TEST_SHARED_RULE -ErrorAction SilentlyContinue | Remove-NetFirewallRule");
				await removeInstallation(directory, await realpath(tmpdir()), 'ash-c-');
			} catch (cleanup) {
				if (failure) throw new Error(`Release acceptance failed: ${String(failure)}\nCleanup also failed: ${String(cleanup)}`, { cause: failure });
				throw cleanup;
			}
		}
	}
});

async function removeInstallation(path: string, parent: string, prefix: string): Promise<void> {
	if (!await exists(path)) return;
	const absolute = await realpath(path);
	assert.equal(dirname(absolute), parent, 'Installation cleanup must stay in the test directory');
	assert(basename(absolute).startsWith(prefix));
	await rm(absolute, { recursive: true, force: true });
}
