import { execFile } from 'node:child_process';
import { access, link, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { appServerDaemonExecutablePath, appServerExecutablePath } from '../../../../src/ash/platform/app-server-daemon/node/appServerDaemonPackage.js';

const execFileAsync = promisify(execFile);

test('Desktop development startup opens Agents with prepared runtime resources', async ({ target, testWorkspace }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'This checks development startup with the Desktop backend.');
	const directory = await mkdtemp(join(tmpdir(), 'ash-'));
	const previousReload = process.env.ASH_DEV_APP_SERVER_RELOAD;
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	try {
		process.env.ASH_DEV_APP_SERVER_RELOAD = '1';
		desktop = await launchElectron({ appServerMode: 'required', userDataDirectory: directory, workspaceDirectory: testWorkspace.directory, workspacePermissions: 'development' });
		const page = desktop.driver.workbench.page;
		const opened = desktop.application.waitForEvent('window');
		await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		const agents = await opened;
		await expect(agents.locator('.ash-sessions-window')).toBeVisible();
		await expect(agents.getByRole('heading', { name: 'Unable to start Ash' })).toHaveCount(0);
	} finally {
		try {
			await desktop?.close();
		} finally {
			if (previousReload === undefined) delete process.env.ASH_DEV_APP_SERVER_RELOAD;
			else process.env.ASH_DEV_APP_SERVER_RELOAD = previousReload;
			await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
		}
	}
});

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
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	try {
		desktop = await launchElectron({ appServerMode: 'required', userDataDirectory: directory, workspaceDirectory: testWorkspace.directory, workspacePermissions: 'development' });
		await desktop.close();
		desktop = undefined;

		desktop = await launchElectron({ appServerMode: 'required', userDataDirectory: directory, workspaceDirectory: testWorkspace.directory });
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
			await rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
		}
	}
});

for (const packageState of ['selected', 'other'] as const) {
	const title = packageState === 'selected'
		? 'Desktop reuses a daemon from the selected development package'
		: 'Desktop replaces a daemon started from another package generation';
	test(title, async ({ target }) => {
		test.skip(target.kind !== 'electron' || target.appServerMode !== 'required', 'Requires the Desktop backend.');
		test.skip(packageState === 'other' && process.platform !== 'win32', 'This checks Windows package identity.');
		const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-'));
		const profile = join(userDataDirectory, 'profile');
		const packageLocation = { appPath: resolve(import.meta.dirname, '../../../..'), isPackaged: false, platform: process.platform, resourcesPath: '' };
		const daemon = appServerDaemonExecutablePath(packageLocation);
		const selectedBackend = appServerExecutablePath(packageLocation);
		const existingBackend = packageState === 'selected' ? selectedBackend : join(userDataDirectory, 'other-app-server.exe');
		const environment = { ...process.env, ASH_HOME: profile, ASH_APP_SERVER_PATH: existingBackend };
		let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
		try {
			// A hard link outside the package keeps the binary identical but changes its package identity.
			if (packageState === 'other') {
				await link(selectedBackend, existingBackend);
			}
			const started = JSON.parse((await execFileAsync(daemon, ['start'], { env: environment, windowsHide: true })).stdout) as { readonly pid: number };
			desktop = await launchElectron({ appServerMode: 'required', userDataDirectory });
			const connected = JSON.parse((await execFileAsync(daemon, ['version'], { env: environment, windowsHide: true })).stdout) as { readonly pid: number };
			expect(connected.pid === started.pid).toBe(packageState === 'selected');
		} finally {
			try {
				await desktop?.close();
			} finally {
				await execFileAsync(daemon, ['stop'], { env: environment, windowsHide: true });
				await rm(userDataDirectory, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
			}
		}
	});
}
