import { execFile } from 'node:child_process';
import { access, link, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { appServerDaemonExecutablePath, appServerExecutablePath } from '../../../../src/ash/platform/app-server/electron-main/appServerPackage.js';

const execFileAsync = promisify(execFile);

test('Desktop uses the selected Ash home for UI and backend startup', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron', 'This scenario verifies process startup on the desktop host.');
	if (target.kind !== 'electron' || !('windows' in application)) {
		return;
	}
	const paths = await application.evaluate(({ app }) => ({
		home: process.env.ASH_HOME,
		legacy: process.env.ASH_PROFILE_ROOT,
		rendererUrl: process.env.ASH_RENDERER_URL,
		userData: app.getPath('userData'),
	}));
	expect(paths.legacy).toBeUndefined();
	expect(paths.rendererUrl).toBeUndefined();
	expect(application.windows()[0].url()).toMatch(/^file:/);
	expect(paths.home).toBeDefined();
	expect(await realpath(paths.home!)).toBe(await realpath(join(paths.userData, 'profile')));
	await expect(workbench.element).toBeVisible();
	if (target.appServerMode === 'required') {
		await expect.poll(async () => access(join(paths.home!, 'state.sqlite3')).then(() => true, () => false)).toBe(true);
	}
});

test('Desktop reopens an authorized workspace after its backend stops', async ({ target, testWorkspace }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'This checks a stopped backend on Desktop.');
	test.setTimeout(90_000);
	const directory = await mkdtemp(join(tmpdir(), 'ash-'));
	const profile = join(directory, 'profile');
	const daemon = appServerDaemonExecutablePath({ appPath: resolve(import.meta.dirname, '../../../..'), isPackaged: false, platform: process.platform, resourcesPath: '' });
	const priorHome = process.env.HOME;
	const priorUserProfile = process.env.USERPROFILE;
	process.env.HOME = directory;
	process.env.USERPROFILE = directory;
	const environment = { ...process.env, ASH_HOME: profile };
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	try {
		// Startup must use test credentials, independent of accounts on the developer's machine.
		const credentials = join(directory, '.zcode', 'v2');
		await mkdir(credentials, { recursive: true });
		const entries: Record<string, string> = {};
		for (const provider of ['bigmodel', 'zai']) {
			const id = `account:${provider}-individual-coding-plan`;
			entries[`account-provider:${id}:identity`] = 'offline-test';
			entries[`account-provider:coding-plan:${id}:account:offline-test:api-key`] = 'offline-test-key';
		}
		await writeFile(join(credentials, 'credentials.json'), JSON.stringify(entries));

		desktop = await launchElectron({ appServerMode: 'required', userDataDirectory: join(directory, 'first'), profileDirectory: profile, workspaceDirectory: testWorkspace.directory, workspacePermissions: 'development' });
		await desktop.close();
		desktop = undefined;
		await execFileAsync(daemon, ['stop'], { env: environment, windowsHide: true, timeout: 30_000 });

		desktop = await launchElectron({ appServerMode: 'required', userDataDirectory: join(directory, 'second'), profileDirectory: profile, workspaceDirectory: testWorkspace.directory });
		const page = desktop.driver.workbench.page;
		await expect(desktop.driver.workbench.element).toBeVisible();
		const showSidebar = page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
		if (await showSidebar.isVisible()) await showSidebar.click();
		const file = page.locator('.ash-explorer .ash-tree-row').filter({ hasText: 'main.ts' });
		await expect(file).toHaveCount(1);
		await file.dblclick();
		await expect(page.locator('.stanza-editor-line-text').first()).toContainText('const value = 1;');
	} finally {
		try {
			await desktop?.close();
		} finally {
			try {
				await execFileAsync(daemon, ['stop'], { env: environment, windowsHide: true, timeout: 30_000 });
			} finally {
				if (priorHome === undefined) delete process.env.HOME;
				else process.env.HOME = priorHome;
				if (priorUserProfile === undefined) delete process.env.USERPROFILE;
				else process.env.USERPROFILE = priorUserProfile;
				await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
			}
		}
	}
});

test('Desktop replaces a daemon started from another package generation', async ({ target }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || process.platform !== 'win32', 'This checks Windows Desktop backend selection.');
	const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-'));
	const profile = join(userDataDirectory, 'profile');
	const appPath = resolve(import.meta.dirname, '../../../..');
	const packageLocation = { appPath, isPackaged: false, platform: process.platform, resourcesPath: '' };
	const daemon = appServerDaemonExecutablePath(packageLocation);
	const selectedBackend = appServerExecutablePath(packageLocation);
	const staleBackend = join(userDataDirectory, 'stale-app-server.exe');
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	try {
		// The same binary outside its package has a different generation identity.
		await link(selectedBackend, staleBackend);
		const environment = { ...process.env, ASH_HOME: profile, ASH_APP_SERVER_PATH: staleBackend };
		const started = JSON.parse((await execFileAsync(daemon, ['start'], { env: environment, windowsHide: true })).stdout) as { readonly pid: number };
		desktop = await launchElectron({ appServerMode: 'required', userDataDirectory });
		const selected = JSON.parse((await execFileAsync(daemon, ['version'], { env: { ...environment, ASH_APP_SERVER_PATH: selectedBackend }, windowsHide: true })).stdout) as { readonly pid: number };
		expect(selected.pid).not.toBe(started.pid);
		await expect(desktop.driver.workbench.element).toBeVisible();
	} finally {
		if (desktop) {
			await desktop.close();
		} else {
			await execFileAsync(daemon, ['stop'], { env: { ...process.env, ASH_HOME: profile, ASH_APP_SERVER_PATH: selectedBackend }, windowsHide: true });
		}
		await rm(userDataDirectory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
	}
});

test('Desktop reuses a daemon from the selected development package', async ({ target }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'This checks the Electron frontend debugging connection.');
	const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-'));
	const profile = join(userDataDirectory, 'profile');
	const appPath = resolve(import.meta.dirname, '../../../..');
	const packageLocation = { appPath, isPackaged: false, platform: process.platform, resourcesPath: '' };
	const daemon = appServerDaemonExecutablePath(packageLocation);
	const selectedBackend = appServerExecutablePath(packageLocation);
	const environment = { ...process.env, ASH_HOME: profile, ASH_APP_SERVER_PATH: selectedBackend };
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	try {
		const started = JSON.parse((await execFileAsync(daemon, ['start'], { env: environment, windowsHide: true })).stdout) as { readonly pid: number };
		desktop = await launchElectron({ appServerMode: 'required', userDataDirectory, profileDirectory: profile });
		const connected = JSON.parse((await execFileAsync(daemon, ['version'], { env: environment, windowsHide: true })).stdout) as { readonly pid: number };
		expect(connected.pid).toBe(started.pid);
		await expect(desktop.driver.workbench.element).toBeVisible();
	} finally {
		try {
			if (desktop) {
				// This test owns the Electron process and profile; quit without waiting for application state flushing.
				desktop.application.process().kill('SIGKILL');
				await desktop.application.close();
			}
		} finally {
			try {
				await execFileAsync(daemon, ['stop'], { env: environment, windowsHide: true });
			} finally {
				await rm(userDataDirectory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
			}
		}
	}
});
