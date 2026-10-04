import { execFile, type ChildProcess } from 'node:child_process';
import { readdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { _electron, chromium, type Browser } from '@playwright/test';
import { expect, test } from '../../automation/test.js';
import { launchElectron } from '../../automation/playwrightElectron.js';
import { launchBrowser } from '../../automation/playwrightBrowser.js';
import { Workbench } from '../../automation/workbench.js';
import { captureElectronMenu } from '../../automation/menus.js';
import { ElectronPlaywrightDriver, waitForElectronWindowState } from '../../automation/electronDriver.js';

test('all smoke projects collect without fixture dependency cycles', async () => {
	const directory = resolve(import.meta.dirname, '../../..');
	const { stdout } = await promisify(execFile)(process.execPath, [
		'node_modules/@playwright/test/cli.js', 'test', '--list',
		'--project=browser-app-server', '--project=electron-ui', '--project=electron-app-server', '--project=electron-pdf-corpus-app-server',
	], { cwd: directory, env: { ...process.env, ASH_PLAYWRIGHT_SERVER: 'full' } });
	expect(stdout).toContain('scm-history.spec.ts');
	expect(stdout).toContain('pdf-academic-corpus.spec.ts');
	expect(stdout).toMatch(/Total: [1-9]\d* tests/u);
});

test.describe('startup diagnostics', () => {
	const waitForReady = Workbench.prototype.waitForReady;
	test.beforeEach(() => {
		Workbench.prototype.waitForReady = async function (): Promise<void> {
			await waitForReady.call(this);
			const emitted = this.page.waitForEvent('console', { predicate: message => message.text() === '[runtime] test startup error' });
			await this.page.evaluate(() => console.error('[runtime] test startup error'));
			await emitted;
		};
	});
	test.afterEach(() => { Workbench.prototype.waitForReady = waitForReady; });

	test('a runtime error before launch completes fails the scenario', async ({ driver }) => {
		expect(driver.diagnostics.errors).toEqual(['[runtime] test startup error']);
		// After confirming collection, fixture teardown must reject the scenario.
		// Ignoring the collected error becomes an unexpected pass.
		test.fail();
	});
});

test('an auxiliary window runtime error fails the scenario', async ({ target, workbench, driver }) => {
	test.skip(target.kind !== 'electron', 'Requires an auxiliary desktop window.');
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const opened = workbench.page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.moveEditorToNewWindow');
	const auxiliary = await opened;
	try {
		await expect(auxiliary.locator('.stanza-editor-input')).toBeVisible();
		const emitted = auxiliary.waitForEvent('console', { predicate: message => message.text() === '[runtime] test auxiliary error' });
		await auxiliary.evaluate(() => console.error('[runtime] test auxiliary error'));
		await emitted;
		expect(driver.diagnostics.errors).toEqual(['[runtime] test auxiliary error']);
		test.fail();
	} finally {
		await auxiliary.close();
	}
});

test('opening Agents again reuses the restored desktop window', async ({ target, workbench }) => {
	test.skip(target.kind !== 'electron', 'Desktop focuses an existing window; Browser navigates the current page.');
	const context = workbench.page.context();
	const originalCount = context.pages().length;
	const agents = await workbench.openAgentsWindow(target.kind);
	const reopened = await workbench.openAgentsWindow(target.kind);
	expect(reopened).toBe(agents);
	expect(context.pages()).toHaveLength(originalCount + 1);
	await expect(agents.locator('.ash-sessions-window')).toBeVisible();
});

test('a failed desktop menu selection restores capture and leaves Main running', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || process.platform !== 'darwin', 'Checks macOS system popup dispatch.');
	if (!('windows' in application)) throw new Error('Expected Electron application');
	const page = await workbench.openAgentsWindow(target.kind);
	const button = page.locator('[data-part="titlebar"]').getByRole('button', { name: 'Application menu', exact: true });
	await expect(captureElectronMenu(application, () => button.click(), { label: 'Missing test menu action' })).rejects.toThrow('Expected enabled menu item: Missing test menu action');
	await expect(button).toHaveAttribute('aria-expanded', 'false');
	const items = await captureElectronMenu(application, () => button.click());
	expect(items.some(item => item.label === 'File')).toBe(true);
	await expect(button).toHaveAttribute('aria-expanded', 'false');
});

test('a failed dialog choice cancels the request and permits the next confirmation', async ({ application, target, workbench }) => {
	test.skip(target.workbenchMode !== 'code', 'Checks the Code editor save confirmation.');
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const group = workbench.editors.groupAt(0);
	const tab = group.tabs.filter({ hasText: 'Untitled-1' });
	await group.editor.input.focus();
	await group.editor.input.pressSequentially('dialog capture draft');
	const close = () => workbench.quickaccess.runCommand('workbench.action.closeActiveEditor');
	await expect(workbench.dialogs.confirm(application, 'Save Changes', 'Missing test dialog button', close)).rejects.toThrow('Expected dialog button: Missing test dialog button');
	await expect(tab).toBeVisible();
	await expect(group.editor.lines).toHaveText(['dialog capture draft']);
	const message = await workbench.dialogs.confirm(application, 'Save Changes', "Don't Save", close);
	expect(message.buttons).toEqual(['Save', "Don't Save", 'Cancel']);
	await expect(tab).toHaveCount(0);
});

test('failed browser navigation closes the allocated browser', async ({}, testInfo) => {
	test.skip(testInfo.project.name !== 'browser-ui', 'Checks the Web launcher without a backend.');
	const launch = chromium.launch;
	let browser: Browser | undefined;
	// Observe the real browser allocated by the launcher, including its failure path.
	chromium.launch = async function (options) { browser = await launch.call(this, options); return browser; };
	try {
		await expect(launchBrowser({ appServerMode: 'disabled', baseURL: 'http://127.0.0.1:1' })).rejects.toThrow('net::ERR_UNSAFE_PORT');
		expect(browser?.isConnected()).toBe(false);
	} finally {
		chromium.launch = launch;
		await browser?.close();
	}
});

test('an uncaught error in another browser page fails the scenario', async ({ target, workbench, driver }) => {
	test.skip(target.kind !== 'browser', 'Checks browser context error reporting.');
	const page = await workbench.page.context().newPage();
	try {
		const emitted = page.waitForEvent('pageerror');
		await page.evaluate(() => { setTimeout(() => { throw new Error('test secondary page error'); }); });
		await emitted;
		expect(driver.diagnostics.errors).toEqual([expect.stringContaining('test secondary page error')]);
		test.fail();
	} finally {
		await page.close();
	}
});

// Both scenarios leave a file and a saved backend preference behind. Either
// order must begin clean, and the Explorer must use that scenario's folder.
for (const scenario of ['first', 'second']) {
	test(`connected Web isolates workspace and profile for the ${scenario} scenario`, async ({ testWorkspace, workbench }, testInfo) => {
		test.skip(testInfo.project.name !== 'browser-app-server', 'Checks per-scenario Web backend ownership.');
		const fileName = 'scenario-created.ts';
		expect(await readdir(testWorkspace.directory)).not.toContain(fileName);
		await writeFile(join(testWorkspace.directory, fileName), 'export const scenario = 1;\n');
		const showSidebar = workbench.page.getByRole('button', { name: 'Show Primary Side Bar', exact: true });
		if (await showSidebar.isVisible()) await showSidebar.click();
		await expect(workbench.page.locator('.ash-explorer .ash-tree-row').filter({ hasText: fileName })).toHaveCount(1);
		await workbench.settingsEditor.openUserSettingsUI();
		const settings = workbench.settingsEditor.element;
		await workbench.settingsEditor.selectCategory('network');
		const mode = settings.getByRole('combobox', { name: 'HTTP compatibility mode', exact: true });
		await expect(mode).toBeEnabled();
		await expect(mode).toContainText('HTTP/2 (recommended)');
		await mode.click();
		await workbench.page.getByRole('option', { name: 'HTTP/1.1', exact: true }).click();
		await expect(settings.locator('.ash-network-settings [role="status"]')).toHaveText('HTTP compatibility mode saved. Subsequent requests use the selected mode.');
	});
}


test('an Electron restoration timeout closes its process before rejecting launch', async ({}, testInfo) => {
	test.skip(!testInfo.project.name.startsWith('electron-'), 'Checks the desktop process lifecycle.');
	const directory = await mkdtemp(join(tmpdir(), 'ash-startup-'));
	const launch = _electron.launch;
	const waitForReady = Workbench.prototype.waitForReady;
	let child: ChildProcess | undefined;
	let reachedRestoration = false;
	_electron.launch = async function (options) {
		const application = await launch.call(this, options);
		child = application.process();
		return application;
	};
	Workbench.prototype.waitForReady = async function () {
		await waitForReady.call(this);
		reachedRestoration = true;
		await new Promise<void>(() => {});
	};
	try {
		await expect(launchElectron({ appServerMode: 'disabled', userDataDirectory: directory, startupTimeout: 10_000 })).rejects.toThrow('Workbench startup timed out');
		expect(reachedRestoration).toBe(true);
		expect(child && (child.exitCode !== null || child.signalCode !== null)).toBe(true);
	} finally {
		_electron.launch = launch;
		Workbench.prototype.waitForReady = waitForReady;
		await rm(directory, { force: true, recursive: true });
	}
});

test('Electron window sizing controls the selected page when another window is open', async ({ application, target, workbench, driver }) => {
	test.skip(target.kind !== 'electron', 'Checks Electron window identity.');
	if (!('windows' in application)) throw new Error('Expected Electron application');
	const agents = await workbench.openAgentsWindow(target.kind);
	const workbenchWindow = await application.browserWindow(workbench.page);
	try {
		const before = await workbenchWindow.evaluate(window => window.getBounds());
		const agentsDriver = new ElectronPlaywrightDriver(application, agents, driver.diagnostics);
		const size = await agentsDriver.setWindowSize({ width: 960, height: 720 });
		const agentsWindow = await application.browserWindow(agents);
		try {
			expect(await agentsWindow.evaluate(window => {
				const bounds = window.getBounds();
				return { width: bounds.width, height: bounds.height };
			})).toEqual(size);
		} finally { await agentsWindow.dispose(); }
		expect(await workbenchWindow.evaluate(window => window.getBounds())).toEqual(before);
	} finally { await workbenchWindow.dispose(); }
});

test('Electron window waits report a locked desktop instead of a focus timeout', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron', 'Checks desktop state diagnostics.');
	if (!('windows' in application)) throw new Error('Expected Electron application');
	const original = await application.evaluateHandle(({ powerMonitor }) => powerMonitor.getSystemIdleState);
	try {
		await application.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleState = () => 'locked'; });
		expect(await application.evaluate(({ powerMonitor }) => powerMonitor.getSystemIdleState(60))).toBe('locked');
		await expect(waitForElectronWindowState(application, workbench.page, { focused: true })).rejects.toThrow('Desktop is locked; window focus and fullscreen cannot be verified');
	} finally {
		await application.evaluate(({ powerMonitor }, original) => { powerMonitor.getSystemIdleState = original; }, original);
		await original.dispose();
	}
});

test('a pending Dock request does not block the first desktop window', async ({}, testInfo) => {
	test.skip(process.platform !== 'darwin' || !testInfo.project.name.startsWith('electron-'), 'Checks macOS application startup.');
	const directory = await mkdtemp(join(tmpdir(), 'ash-dock-'));
	const desktopDirectory = resolve(import.meta.dirname, '../../..');
	// Keep the entry in app-ts so Electron retains the real app path and resources.
	const entry = join(desktopDirectory, `.ash-test-dock-${randomUUID()}.cjs`);
	const launch = _electron.launch;
	try {
		await writeFile(entry, `const { app } = require('electron/main');\nconst pendingDock = () => new Promise(() => {});\napp.dock.show = pendingDock;\nglobalThis.ashTestDockInstalled = app.dock.show === pendingDock;\nvoid import('../.build/app-ts/main/src/main.js');\n`);
		_electron.launch = function (options) {
			expect(options!.args).toContain(desktopDirectory);
			return launch.call(this, { ...options, args: options!.args!.map(argument => argument === desktopDirectory ? entry : argument) });
		};
		const running = await launchElectron({ appServerMode: 'disabled', userDataDirectory: directory, startupTimeout: 10_000 });
		try {
			expect(await running.application.evaluate(({ app }) => ({
				installed: (globalThis as typeof globalThis & { ashTestDockInstalled?: boolean }).ashTestDockInstalled,
				visible: app.dock!.isVisible(),
			}))).toEqual({ installed: true, visible: true });
			await expect(running.driver.workbench.element).toBeVisible();
		}
		finally { await running.close(); }
	} finally {
		_electron.launch = launch;
		await rm(entry, { force: true });
		await rm(directory, { recursive: true, force: true });
	}
});

test('an Electron shutdown that refuses to quit terminates its owned process tree', async ({}, testInfo) => {
	test.skip(!testInfo.project.name.startsWith('electron-'), 'Checks the desktop process lifecycle.');
	const directory = await mkdtemp(join(tmpdir(), 'ash-shutdown-'));
	try {
		const running = await launchElectron({ appServerMode: 'disabled', userDataDirectory: directory });
		const child = running.application.process();
		let closing: Promise<void> | undefined;
		try {
			await running.application.evaluate(({ app }) => { app.quit = () => {}; });
			closing = running.close();
			await expect(closing).rejects.toThrow('process tree was terminated');
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		} finally {
			if (!closing) await running.close();
		}
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
