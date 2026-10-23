import { execFile, type ChildProcess } from 'node:child_process';
import { readdir, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
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

test('ordinary Electron tests keep startup, new windows and reloads from taking system focus', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, target, workbench, reloadWorkbench }) => {
	if (!('windows' in application)) throw new Error('Expected Electron windows');
	const readWindows = () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
		focused: window.isFocused(), focusable: window.isFocusable(), visible: window.isVisible(),
	})));
	const visible = false;
	expect(await application.evaluate(() => process.env.ASH_TEST_WINDOW_MODE)).toBe('hidden');
	await expect.poll(readWindows).toEqual([{ focused: false, focusable: false, visible }]);
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	const input = workbench.editors.groupAt(0).editor.input;
	await input.focus();
	await workbench.page.keyboard.insertText('background keyboard input');
	await workbench.editors.groupAt(0).editor.waitForEditorContents(text => text === 'background keyboard input');
	const detached = workbench.page.context().waitForEvent('page');
	await workbench.quickaccess.runCommand('workbench.action.moveEditorToNewWindow');
	const auxiliary = await detached;
	await expect(auxiliary.locator('.ash-auxiliary-window-container .ash-workbench-editor')).toBeVisible();
	await expect.poll(readWindows).toEqual(Array.from({ length: 2 }, () => ({ focused: false, focusable: false, visible })));
	await auxiliary.close();
	const agents = await workbench.openAgentsWindow('electron');
	await expect(agents.locator('.ash-sessions-window')).toBeVisible();
	await application.evaluate(({ BrowserWindow }) => {
		for (const window of BrowserWindow.getAllWindows()) { window.show(); window.focus(); }
	});
	await expect.poll(readWindows).toEqual(Array.from({ length: 2 }, () => ({ focused: false, focusable: false, visible })));
	await input.focus();
	await workbench.page.keyboard.press('ControlOrMeta+A');
	await workbench.page.keyboard.press('Backspace');
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	const reopened = await reloadWorkbench();
	if (!('windows' in reopened.application)) throw new Error('Expected Electron windows');
	expect(await reopened.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
		focused: window.isFocused(), focusable: window.isFocusable(), visible: window.isVisible(),
	})))).toEqual([{ focused: false, focusable: false, visible }]);
});

test.describe('background Electron test launches preserve the active application', () => {
	// The foreground process must own real OS focus before the background launch.
	test.use({ electronWindowMode: 'active' });
	for (const windowMode of ['hidden', 'inactive'] as const) {
		test(`Electron ${windowMode} launch preserves another application's system focus`, { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, target, workbench }, testInfo) => {
			if (!('windows' in application)) throw new Error('Expected Electron windows');
			await application.evaluate(({ app, BrowserWindow }) => {
				app.focus({ steal: true });
				BrowserWindow.getAllWindows()[0]!.focus();
			});
			await waitForElectronWindowState(application, workbench.page, { focused: true });
			const userDataDirectory = testInfo.outputPath('background-user-data');
			await mkdir(userDataDirectory, { recursive: true });
			const background = await launchElectron({ appServerMode: 'disabled', userDataDirectory, windowMode });
			try {
				expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFocused())).toBe(true);
				expect(await background.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
					focused: window.isFocused(), focusable: window.isFocusable(), visible: window.isVisible(),
				})))).toEqual([{ focused: false, focusable: false, visible: windowMode === 'inactive' }]);
				expect(await application.evaluate(() => process.env.ASH_TEST_WINDOW_MODE)).toBeUndefined();
			} finally { await background.close(); }
		});
	}
});

test('all smoke projects collect without fixture dependency cycles', async () => {
	const directory = resolve(import.meta.dirname, '../../..');
	const { stdout } = await promisify(execFile)(process.execPath, [
		'node_modules/@playwright/test/cli.js', 'test', '--list',
		'--project=browser-app-server', '--project=electron-ui', '--project=electron-app-server', '--project=electron-pdf-corpus-app-server',
	], { cwd: directory, env: { ...process.env, ASH_PLAYWRIGHT_SERVER: 'full' } });
	expect(stdout).toContain('scm-history.spec.ts');
	expect(stdout).toContain('pdf-academy-corpus.spec.ts');
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

test('an auxiliary window runtime error fails the scenario', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ target, workbench, driver }) => {
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

test('opening Agents again reuses the restored desktop window', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ target, workbench }) => {
	const context = workbench.page.context();
	const originalCount = context.pages().length;
	const agents = await workbench.openAgentsWindow(target.kind);
	const reopened = await workbench.openAgentsWindow(target.kind);
	expect(reopened).toBe(agents);
	expect(context.pages()).toHaveLength(originalCount + 1);
	await expect(agents.locator('.ash-sessions-window')).toBeVisible();
});

test('a failed desktop menu selection restores capture and leaves Main running', { tag: ['@electron-ui', '@electron-app-server', '@darwin'] }, async ({ application, workbench }) => {
	if (!('windows' in application)) throw new Error('Expected Electron application');
	await workbench.quickaccess.runCommand('workbench.action.files.newUntitledFile');
	// macOS owns the application menu in the system menubar. A tab context
	// menu exercises the real renderer-to-Main popup and its capture cleanup.
	const tab = workbench.editors.groupAt(0).tabs.filter({ hasText: 'Untitled-1' });
	const open = () => tab.click({ button: 'right' });
	await expect(captureElectronMenu(application, open, { label: 'Missing test menu action' })).rejects.toThrow('Expected enabled menu item: Missing test menu action');
	await expect(tab).toBeVisible();
	const items = await captureElectronMenu(application, open);
	expect(items.some(item => item.label === 'Close')).toBe(true);
	await expect(tab).toBeVisible();
	await captureElectronMenu(application, open, { label: 'Close' });
	await expect(tab).toHaveCount(0);
});

test('a failed dialog choice cancels the request and permits the next confirmation', async ({ application, workbench }) => {
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

test('failed browser navigation closes the allocated browser', { tag: ['@browser-ui'] }, async ({ }, testInfo) => {
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

test('an uncaught error in another browser page fails the scenario', { tag: ['@browser-ui', '@browser-app-server'] }, async ({ target, workbench, driver }) => {
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
	test(`connected Web isolates workspace and profile for the ${scenario} scenario`, { tag: ['@browser-app-server'] }, async ({ testWorkspace, workbench }, testInfo) => {
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


test('an Electron restoration timeout closes its process before rejecting launch', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ }, testInfo) => {
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
		await new Promise<void>(() => { });
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

test('Electron window sizing controls the selected page when another window is open', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, target, workbench, driver }) => {
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

test('Electron window waits report a locked desktop instead of a focus timeout', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ application, target, workbench }) => {
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

test('a pending Dock request does not block the first desktop window', { tag: ['@electron-ui', '@electron-app-server', '@darwin'] }, async ({ }, testInfo) => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-dock-'));
	const desktopDirectory = process.env.ASH_SMOKE_DESKTOP_DIRECTORY ?? resolve(import.meta.dirname, '../../..');
	// The injected entry uses the prepared application's resources, including artifact snapshots.
	const entry = join(desktopDirectory, `.ash-test-dock-${randomUUID()}.cjs`);
	const launch = _electron.launch;
	try {
		await writeFile(entry, `const { app } = require('electron/main');
const pendingDock = () => {
	globalThis.ashTestDockRequested = true;
	return new Promise(() => {});
};
app.dock.show = pendingDock;
globalThis.ashTestDockInstalled = app.dock.show === pendingDock;
globalThis.ashTestDockSettled = false;
void app.whenReady().then(() => {
	void app.dock.show().then(() => { globalThis.ashTestDockSettled = true; });
});
void import('./.build/desktop/main/src/main.js').catch(error => {
	console.error(error);
	app.exit(1);
});
`);
		_electron.launch = function (options) {
			expect(options!.args).toContain(desktopDirectory);
			return launch.call(this, { ...options, args: options!.args!.map(argument => argument === desktopDirectory ? entry : argument) });
		};
		const running = await launchElectron({ appServerMode: 'disabled', userDataDirectory: directory, startupTimeout: 10_000 });
		try {
			const background = await running.application.evaluate(() => process.env.ASH_TEST_WINDOW_MODE !== undefined);
			expect(await running.application.evaluate(({ app }) => {
				const state = globalThis as typeof globalThis & { ashTestDockInstalled?: boolean; ashTestDockRequested?: boolean; ashTestDockSettled?: boolean; };
				return { installed: state.ashTestDockInstalled, requested: state.ashTestDockRequested, settled: state.ashTestDockSettled, visible: app.dock!.isVisible() };
			})).toEqual({ installed: true, requested: true, settled: false, visible: !background });
			await expect(running.driver.workbench.element).toBeVisible();
		}
		finally { await running.close(); }
	} finally {
		_electron.launch = launch;
		await rm(entry, { force: true });
		await rm(directory, { recursive: true, force: true });
	}
});

test('an Electron shutdown that refuses to quit terminates its owned process tree', { tag: ['@electron-ui', '@electron-app-server'] }, async ({ }, testInfo) => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-shutdown-'));
	try {
		const running = await launchElectron({ appServerMode: 'disabled', userDataDirectory: directory });
		const child = running.application.process();
		let closing: Promise<void> | undefined;
		try {
			await running.application.evaluate(({ app }) => { app.quit = () => { }; });
			closing = running.quit();
			await expect(closing).rejects.toThrow('process tree was terminated');
			expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
		} finally {
			if (!closing) await running.close();
		}
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
