import { execFile } from 'node:child_process';
import { access, link, mkdtemp, realpath, rm } from 'node:fs/promises';
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
