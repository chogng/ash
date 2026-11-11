import { execFile } from 'node:child_process';
import { access, link, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '../../../automation/test.js';
import { launchElectron } from '../../../automation/playwrightElectron.js';
import { QuickAccess } from '../../../automation/quickaccess.js';
import { appServerDaemonExecutablePath, appServerExecutablePath } from '../../../../src/ash/platform/app-server-daemon/node/appServerDaemonPackage.js';

const execFileAsync = promisify(execFile);
const emptyWindowTest = test.extend({ openWorkspace: false });

test('UI startup does not resolve or require a backend package', { tag: ['@electron-ui'] }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-ui-startup-'));
	const lookup = join(directory, 'backend-lookup');
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	try {
		desktop = await launchElectron({
			appServerMode: 'disabled', userDataDirectory: join(directory, 'home'),
			environment: { ...process.env, ASH_TEST_REJECT_BACKEND_PACKAGE: lookup },
		});
		await expect(desktop.driver.workbench.element).toBeVisible();
		expect(await readFile(`${lookup}.ready`, 'utf8')).toBe('ready');
		expect(await desktop.application.evaluate(() => process.env.ASH_DESKTOP_UI_ONLY)).toBe('1');
		expect(await access(lookup).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
	} finally {
		try { await desktop?.close(); }
		finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
	}
});

test('Desktop development startup opens Agents with prepared runtime resources', { tag: ['@electron-app-server'] }, async ({ target, testWorkspace }) => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-'));
	const previousReload = process.env.ASH_DEV_APP_SERVER_RELOAD;
	let desktop: Awaited<ReturnType<typeof launchElectron>> | undefined;
	try {
		process.env.ASH_DEV_APP_SERVER_RELOAD = '1';
		desktop = await launchElectron({ appServerMode: 'required', userDataDirectory: directory, workspaceDirectory: testWorkspace.directory, workspacePermissions: 'development' });
		const page = desktop.driver.workbench.page;
		await page.context().addInitScript(() => {
			if (!location.pathname.endsWith('/sessions.html')) return;
			const startupLayout = new Promise<number>(resolve => {
				let provisionalFrames = 0;
				const sample = () => {
					const shell = document.querySelector('.ash-sessions-window');
					if (shell?.querySelector('.ash-sessions-chat-view-empty')?.checkVisibility({ visibilityProperty: true })) provisionalFrames++;
					if (shell?.getAttribute('aria-busy') === 'false') resolve(provisionalFrames);
					else requestAnimationFrame(sample);
				};
				requestAnimationFrame(sample);
			});
			Object.assign(window, { startupLayout });
		});
		const opened = desktop.application.waitForEvent('window');
		await page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
		const agents = await opened;
		await expect(agents.locator('.ash-sessions-window')).toBeVisible();
		await expect(agents.getByRole('heading', { name: 'Unable to start Ash' })).toHaveCount(0);
		await expect(agents.locator('.ash-sessions-window')).toHaveAttribute('aria-busy', 'false');
		await expect(agents.locator('.ash-reply-chat-editor .chat-composer:visible')).toHaveCount(1);
		expect(await agents.evaluate(() => (window as Window & { startupLayout?: Promise<number>; }).startupLayout)).toBe(0);
		await new QuickAccess(agents).runCommand('sessions.action.manageAgentHosts');
		const remotes = agents.getByRole('dialog', { name: 'Remote Environments' });
		await expect(remotes.getByRole('status')).toHaveText('No remote environments');
		await remotes.getByRole('button', { name: 'Close', exact: true }).click();
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

emptyWindowTest('Desktop uses the selected Ash home for UI and backend startup', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, target, workbench }) => {
	if (target.kind !== 'electron' || !('windows' in application)) {
		return;
	}
	const paths = await application.evaluate(({ app }) => ({
		home: process.env.ASH_HOME,
		hostHome: process.env.HOME,
		hostUserProfile: process.env.USERPROFILE,
		codexHome: process.env.CODEX_HOME,
		legacy: process.env.ASH_PROFILE_ROOT,
		rendererUrl: process.env.ASH_RENDERER_URL,
		userData: app.getPath('userData'),
	}));
	expect(paths.legacy).toBeUndefined();
	expect(paths.rendererUrl).toBeUndefined();
	expect(application.windows()[0].url()).toMatch(/^file:/);
	expect(paths.home).toBeDefined();
	expect(await realpath(paths.hostHome!)).toBe(await realpath(paths.userData));
	if (process.platform === 'win32') expect(await realpath(paths.hostUserProfile!)).toBe(await realpath(paths.userData));
	expect(paths.codexHome).toBeUndefined();
	expect(await realpath(paths.home!)).toBe(await realpath(join(paths.userData, 'profile')));
	await expect(workbench.element).toBeVisible();
	if (target.appServerMode === 'required') {
		await expect.poll(async () => access(join(paths.home!, 'state.sqlite3')).then(() => true, () => false)).toBe(true);
	}
});

test('Desktop reopens an authorized workspace after its backend stops', { tag: ['@electron-app-server'] }, async ({ target, testWorkspace }) => {
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
		await expect(page.getByRole('tabpanel', { name: 'main.ts', exact: true })).toContainText('const value = 1;');
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
	test(title, { tag: ['@electron-app-server'] }, async ({ target }) => {
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
			const started = JSON.parse((await execFileAsync(daemon, ['start'], { env: environment, windowsHide: true })).stdout) as { readonly pid: number; };
			desktop = await launchElectron({ appServerMode: 'required', userDataDirectory });
			const connected = JSON.parse((await execFileAsync(daemon, ['version'], { env: environment, windowsHide: true })).stdout) as { readonly pid: number; };
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


test('startup marks record shell readiness and completed restoration in the running workbench', async ({ target, workbench }) => {
	const page = workbench.page;
	await expect.poll(() => page.evaluate(() => performance.getEntriesByName('ash.workbench.restored').length)).toBe(1);
	const timings = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('mark').filter(mark => mark.name.startsWith('ash.')).map(mark => [mark.name, mark.startTime])));
	// The shell callback runs after synchronous construction completes.
	const workbenchStages = ['constructor-start', 'services-ready', 'constructor-done', 'shell-ready', 'views-restored', 'restored'];
	for (const stage of workbenchStages) {
		expect(timings[`ash.workbench.${stage}`], stage).toBeDefined();
	}
	for (let index = 1; index < workbenchStages.length; index++) {
		expect(timings[`ash.workbench.${workbenchStages[index]}`], `${workbenchStages[index]} follows ${workbenchStages[index - 1]}`).toBeGreaterThanOrEqual(timings[`ash.workbench.${workbenchStages[index - 1]}`]!);
	}
	if (target.kind === 'electron') {
		const desktopStages = ['open-start', 'api-ready', 'configuration-ready', 'workbench-start', 'workbench-created', 'lifecycle-ready'];
		for (let index = 0; index < desktopStages.length; index++) {
			const mark = timings[`ash.desktop.${desktopStages[index]}`];
			expect(mark, desktopStages[index]).toBeDefined();
			if (index > 0) { expect(mark).toBeGreaterThanOrEqual(timings[`ash.desktop.${desktopStages[index - 1]}`]!); }
		}
		for (const stage of ['contributions-ready', 'themes-ready', 'workspace-ready']) {
			const mark = timings[`ash.desktop.${stage}`];
			expect(mark, stage).toBeLessThanOrEqual(timings['ash.desktop.configuration-ready']!);
		}
		expect(timings['ash.desktop.contributions-start']).toBeLessThanOrEqual(timings['ash.desktop.contributions-ready']!);
		if (target.appServerMode === 'required') {
			const connectionStages = ['rendererApi.start', 'rendererApi.connect-start', 'appServer.acquire-start', 'appServer.acquired', 'rendererApi.initialized', 'rendererApi.workspace-initialized'];
			for (let index = 0; index < connectionStages.length; index++) {
				const mark = timings[`ash.${connectionStages[index]}`];
				expect(mark, connectionStages[index]).toBeDefined();
				if (index > 0) { expect(mark).toBeGreaterThanOrEqual(timings[`ash.${connectionStages[index - 1]}`]!); }
			}
		} else {
			expect(timings['ash.rendererApi.initialized']).toBeUndefined();
			expect(timings['ash.rendererApi.workspace-initialized']).toBeUndefined();
		}
	}
});
