import { expect, test } from "../../../automation/test.js";
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { launchElectron } from '../../../automation/playwrightElectron.js';

test('Browser Code Sessions Activity Bar centers icons and changes size and position through its menu', async ({ target, workbench }) => {
	test.skip(target.kind !== 'browser' || target.workbenchMode !== 'code', 'Requires the browser Code Sessions page');
	const page = workbench.page;
	await page.locator('[data-action-id="ash.code.open-sessions"] button').click();
	const activityBar = page.locator('[data-part="activitybar"]');
	await expect(activityBar).toBeVisible();
	await expect(activityBar.locator('.ash-sessions-activity-top button svg').first()).toHaveAttribute('data-ash-icon-id', 'chat-2-filled');
	await expect(activityBar.locator('.ash-sessions-activity-bottom button svg').first()).toHaveAttribute('data-ash-icon-id', 'device-mobile');
	const chatButton = activityBar.locator('button').first();
	const buttonBounds = await chatButton.boundingBox();
	const iconBounds = await chatButton.locator('svg').boundingBox();
	expect(buttonBounds).not.toBeNull();
	expect(iconBounds).not.toBeNull();
	expect(buttonBounds!.width).toBe(36);
	expect(buttonBounds!.height).toBe(36);
	expect(iconBounds!.width).toBe(20);
	expect(iconBounds!.height).toBe(20);
	const collaborationIcon = activityBar.locator('button svg[data-ash-icon-id="colab"]');
	await expect(collaborationIcon).toHaveCSS('width', '20px');
	expect(Math.abs(iconBounds!.x + iconBounds!.width / 2 - (buttonBounds!.x + buttonBounds!.width / 2))).toBeLessThanOrEqual(1);
	expect(Math.abs(iconBounds!.y + iconBounds!.height / 2 - (buttonBounds!.y + buttonBounds!.height / 2))).toBeLessThanOrEqual(1);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Size' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Compact' }).click();
	await expect.poll(() => chatButton.evaluate(button => button.getBoundingClientRect().width)).toBe(28);
	await expect(collaborationIcon).toHaveCSS('width', '16px');
	await expect.poll(() => activityBar.evaluate(bar => bar.getBoundingClientRect().width)).toBe(36);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Top' }).click();
	await expect(activityBar).toBeHidden();
	const topHost = page.locator('.ash-sessions-activity-host.top');
	await expect(topHost).toBeVisible();
	await expect(topHost.locator('button').first()).toHaveAttribute('aria-label', /Chat/);
	await topHost.locator('button').first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Bottom' }).click();
	await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeVisible();
	await expect(topHost).toBeHidden();
	await page.locator('.ash-sessions-activity-host.bottom button').first().click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Default' }).click();
	await expect(activityBar).toBeVisible();
	await expect.poll(() => activityBar.evaluate(bar => bar.getBoundingClientRect().width)).toBe(36);
	await chatButton.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Activity Bar Position' }).click();
	await page.getByRole('menuitemcheckbox', { name: 'Hidden' }).click();
	await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeHidden();
	await expect(activityBar).toBeHidden();
});

test('Electron Code Sessions Activity Bar follows its position and size settings', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'Requires the Code Sessions window');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const sessionPagePromise = application.waitForEvent('window');
	await workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const page = await sessionPagePromise;
	const original = await page.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return (await ipc.invoke('ash:configuration:read') as { document: { source: string } }).document.source;
	});
	const updateSettings = async (location: string, compact: boolean): Promise<void> => {
		await page.evaluate(async values => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { version: 1; source: string } };
			const settings = JSON.parse(snapshot.document.source) as Record<string, unknown>;
			settings['sessions.activityBar.location'] = values.location;
			settings['sessions.activityBar.compact'] = values.compact;
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(settings) } });
		}, { location, compact });
	};
	try {
		await updateSettings('default', false);
		const chatButton = page.locator('[data-part="activitybar"] button').first();
		await expect(chatButton).toBeVisible();
		await chatButton.click({ button: 'right' });
		await page.keyboard.press('Escape');
		await updateSettings('default', true);
		await expect.poll(() => chatButton.evaluate(button => button.getBoundingClientRect().width)).toBe(28);
		await updateSettings('top', true);
		await expect(page.locator('[data-part="activitybar"]')).toBeHidden();
		await expect(page.locator('.ash-sessions-activity-host.top')).toBeVisible();
		await page.reload();
		await expect(page.locator('.ash-sessions-activity-host.top')).toBeVisible();
		await updateSettings('bottom', true);
		await expect(page.locator('.ash-sessions-activity-host.bottom')).toBeVisible();
	} finally {
		await page.evaluate(async source => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number };
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source } });
		}, original);
	}
});

test('Sessions and IDE layout styles switch independently', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'Requires the Code Sessions window');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const sessionsPagePromise = application.waitForEvent('window');
	await workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const sessionsPage = await sessionsPagePromise;
	const sessionsWindow = sessionsPage.locator('.ash-sessions-window');
	await expect(sessionsWindow).toBeVisible();
	const original = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return (await ipc.invoke('ash:configuration:read') as { document: { source: string } }).document.source;
	});
	const updateSettings = async (values: Record<string, string>): Promise<void> => {
		await sessionsPage.evaluate(async changes => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { version: 1; source: string } };
			const settings = JSON.parse(snapshot.document.source) as Record<string, unknown>;
			for (const [key, value] of Object.entries(changes)) settings[key] = value;
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(settings) } });
		}, values);
	};
	const gap = () => sessionsPage.evaluate(() => {
		const sidebar = document.querySelector<HTMLElement>('[data-part="sidebar"]');
		const sessions = document.querySelector<HTMLElement>('[data-part="sessions"]');
		if (!sidebar || !sessions) throw new Error('Sessions regions are missing');
		return Math.round(sessions.getBoundingClientRect().left - sidebar.getBoundingClientRect().right);
	});
	try {
		await updateSettings({ 'workbench.layoutStyle': 'modern', 'sessions.layoutStyle': 'modern' });
		await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'modern');
		await expect.poll(gap).toBe(6);
		await updateSettings({ 'workbench.layoutStyle': 'flat' });
		await expect(workbench.element).toHaveAttribute('data-layout-style', 'flat');
		await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'modern');
		await updateSettings({ 'sessions.layoutStyle': 'flat' });
		await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'flat');
		await expect.poll(gap).toBe(0);
		await expect(sessionsPage.locator('[data-part="sessions"]')).toHaveCSS('border-top-left-radius', '0px');
		await sessionsPage.reload();
		await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'flat');
		await expect.poll(gap).toBe(0);
		await updateSettings({ 'sessions.layoutStyle': 'modern' });
		await expect(sessionsWindow).toHaveAttribute('data-layout-style', 'modern');
		await expect.poll(gap).toBe(6);
		await expect(sessionsPage.locator('[data-part="sessions"]')).toHaveCSS('border-top-left-radius', '8px');
	} finally {
		await sessionsPage.evaluate(async source => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number };
			await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source } });
		}, original);
	}
});

test('Sessions applies an installed extension color theme', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.appServerMode !== 'required' || target.workbenchMode !== 'code', 'Requires Code Sessions and App Server extension resources');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const openSessions = workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button");
	const sessionPagePromise = application.waitForEvent('window');
	await openSessions.click();
	const sessionsPage = await sessionPagePromise;
	await expect(sessionsPage.locator('.ash-code-sessions-window')).toBeVisible();
	await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
		const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { source: string } };
		const values = JSON.parse(snapshot.document.source);
		values['workbench.colorTheme'] = 'extension-vscode-theme-defaults-visual-studio-dark';
		await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(values) } });
	});
	await expect(sessionsPage.locator('#app')).toHaveAttribute('data-color-theme', 'extension-vscode-theme-defaults-visual-studio-dark');
	await expect.poll(() => sessionsPage.locator('#app').evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background').trim())).toBe('#1e1e1e');
	await expect(workbench.element).toHaveAttribute('data-color-theme', 'extension-vscode-theme-defaults-visual-studio-dark');
	await expect.poll(() => workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background').trim())).toBe('#1e1e1e');
});

test("Code opens Sessions in a dedicated Electron window and returns to Workbench", async ({ application, target, workbench }) => {
	test.skip(
		target.kind !== "electron" || target.workbenchMode !== "code",
		"This scenario verifies the Code Electron Sessions window.",
	);
	if (target.kind !== "electron") {
		return;
	}
	if (!("windows" in application)) {
		throw new Error("Dedicated Sessions window verification requires Electron");
	}

	const workbenchPage = workbench.page;
	const openSessions = workbenchPage.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button");
	await expect(openSessions).toBeVisible();
	const sessionPagePromise = application.waitForEvent("window");
	await openSessions.click();
	const sessionsPage = await sessionPagePromise;
	await sessionsPage.waitForLoadState("domcontentloaded");
	await expect(sessionsPage.locator(".ash-code-sessions-window")).toBeVisible();
	const resources = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		const configuration = await ipc.invoke('ash:configuration:read') as { readonly revision: number };
		const keybindings = await ipc.invoke('ash:keybindings-resource:read') as { readonly revision: number; readonly bindings: readonly unknown[] };
		const connection = await ipc.invoke('ash:remote:connection') as { readonly kind: string };
		return { configurationRevision: configuration.revision, keybindingsRevision: keybindings.revision, bindings: keybindings.bindings.length, connectionKind: connection.kind };
	});
	expect(resources).toEqual({ configurationRevision: expect.any(Number), keybindingsRevision: expect.any(Number), bindings: expect.any(Number), connectionKind: 'local' });
	const childWindowOperations = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: {
			invoke(channel: string, params?: unknown): Promise<unknown>;
			on(channel: string, listener: (value: unknown) => void): { dispose(): void };
		} } }).ash.ipcRenderer;
		const windows = await ipc.invoke('ash:window:operation', { kind: 'list' }) as readonly { readonly id: number; readonly title: string }[];
		const sessions = windows.find(window => window.title.includes('Sessions'));
		if (!sessions) throw new Error('Sessions window is missing from window list');
		const zoomChange = new Promise<number>((resolve, reject) => {
			const subscription = ipc.on('ash:window:zoom-changed', value => {
				clearTimeout(timeout);
				subscription.dispose();
				resolve(value as number);
			});
			const timeout = setTimeout(() => {
				subscription.dispose();
				reject(new Error('Dedicated window zoom change was not delivered'));
			}, 2_000);
		});
		await ipc.invoke('ash:window:operation', { kind: 'setZoom', level: 1 });
		const changedZoom = await zoomChange;
		const zoom = await ipc.invoke('ash:window:operation', { kind: 'getZoom' });
		await ipc.invoke('ash:window:operation', { kind: 'setZoom', level: 0 });
		return { count: windows.length, changedZoom, zoom };
	});
	expect(childWindowOperations).toEqual({ count: 2, changedZoom: 1, zoom: 1 });
	await sessionsPage.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+W' : 'Control+Alt+W');
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().includes('/workbench/workbench.html'))).toBe(true);
	await openSessions.click();
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().includes('/sessions/sessions-code.html'))).toBe(true);
	const configurationChange = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: {
			invoke(channel: string, params?: unknown): Promise<unknown>;
			on(channel: string, listener: (value: unknown) => void): { dispose(): void };
		} } }).ash.ipcRenderer;
		const before = await ipc.invoke('ash:configuration:read') as { readonly revision: number; readonly document: { readonly version: 1; readonly source: string } };
		const changed = new Promise<number>((resolve, reject) => {
			const subscription = ipc.on('ash:configuration:changed', value => {
				clearTimeout(timeout);
				subscription.dispose();
				resolve((value as { readonly revision: number }).revision);
			});
			const timeout = setTimeout(() => {
				subscription.dispose();
				reject(new Error('Sessions configuration change was not delivered'));
			}, 2_000);
		});
		const updated = await ipc.invoke('ash:configuration:update', {
			expectedRevision: before.revision,
			document: { ...before.document, source: `${before.document.source}\n` },
		}) as { readonly revision: number };
		const notifiedRevision = await changed;
		await ipc.invoke('ash:configuration:update', { expectedRevision: updated.revision, document: before.document });
		return { updatedRevision: updated.revision, notifiedRevision };
	});
	expect(configurationChange.updatedRevision).toBe(configurationChange.notifiedRevision);
	await expect(sessionsPage.locator(".ash-code-sessions-window")).toHaveCSS("display", "flex");
	await expect(sessionsPage.locator("#app")).toHaveAttribute("data-workbench-mode", "code");
	await expect(sessionsPage.locator("#app")).toHaveAttribute("data-runtime", "electron");
	await expect(sessionsPage.locator("#app")).toHaveAttribute("data-workbench-state", "empty");
	await sessionsPage.emulateMedia({ colorScheme: "dark" });
	await expect(sessionsPage.locator("#app")).toHaveAttribute("data-color-theme", "ash-dark");
	await expect.poll(() => sessionsPage.locator("#app").evaluate(element => getComputedStyle(element).getPropertyValue("--ash-title-bar-background").trim())).toBe("#1e1e1e");
	await sessionsPage.emulateMedia({ colorScheme: "light" });
	await expect(sessionsPage.locator("#app")).toHaveAttribute("data-color-theme", "ash-light");
	await expect.poll(() => sessionsPage.locator("#app").evaluate(element => getComputedStyle(element).getPropertyValue("--ash-title-bar-background").trim())).toBe("#ffffff");
	const originalThemeSettings = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
		const snapshot = await ipc.invoke('ash:configuration:read') as { readonly revision: number; readonly document: { readonly version: 1; readonly source: string } };
		const values = JSON.parse(snapshot.document.source);
		values['workbench.colorTheme'] = 'ash-dark';
		await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(values) } });
		return snapshot.document;
	});
	await expect(sessionsPage.locator('#app')).toHaveAttribute('data-color-theme', 'ash-dark');
	await expect(workbench.element).toHaveAttribute('data-color-theme', 'ash-dark');
	await sessionsPage.emulateMedia({ colorScheme: 'dark' });
	await sessionsPage.evaluate(async document => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
		const snapshot = await ipc.invoke('ash:configuration:read') as { readonly revision: number };
		await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document });
	}, originalThemeSettings);
	await expect(sessionsPage.locator('#app')).toHaveAttribute('data-color-theme', 'ash-dark');
	const titlebar = sessionsPage.locator("[data-part='titlebar']");
	await expect(titlebar).toBeVisible();
	await expect(titlebar).toHaveCSS('-webkit-app-region', 'drag');
	await expect(sessionsPage.getByRole('button', { name: 'Return to Workbench' })).toHaveCSS('-webkit-app-region', 'no-drag');
	const [titleBounds, titlebarBounds] = await Promise.all([
		titlebar.locator('.ash-sessions-titlebar-title').boundingBox(),
		titlebar.boundingBox(),
	]);
	expect(titleBounds).not.toBeNull();
	expect(titlebarBounds).not.toBeNull();
	expect(titleBounds!.x).toBeGreaterThan(titlebarBounds!.x);
	expect(titleBounds!.x).toBeLessThan(titlebarBounds!.x + titlebarBounds!.width / 2);
	if (process.platform === 'darwin') {
		const avatar = sessionsPage.locator('.ash-sessions-titlebar-avatar');
		const spacer = sessionsPage.locator('.ash-sessions-window-controls-spacer');
		await expect(spacer).toBeVisible();
		const bounds = await avatar.boundingBox();
		expect(bounds?.x).toBeGreaterThanOrEqual(80);
		await sessionsPage.evaluate(async () => {
			const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string, params: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			await ipc.invoke('ash:window:operation', { kind: 'setZoom', level: -2 });
		});
		await expect.poll(() => spacer.evaluate(element => Number.parseFloat(getComputedStyle(element).width))).toBeGreaterThan(90);
		await sessionsPage.evaluate(async () => {
			const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string, params: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			await ipc.invoke('ash:window:operation', { kind: 'setZoom', level: 0 });
		});
		await application.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('sessions-code.html'));
			if (!window) throw new Error('Sessions window is missing');
			window.setFullScreen(true);
		});
		await expect(sessionsPage.locator('#app')).toHaveClass(/ash-sessions-fullscreen/u);
		await expect(spacer).toBeHidden();
		expect((await avatar.boundingBox())?.x).toBeLessThan(50);
		await application.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('sessions-code.html'));
			if (!window) throw new Error('Sessions window is missing');
			window.setFullScreen(false);
		});
		await expect(spacer).toBeVisible();
	}
	await expect(sessionsPage.locator("[data-part='activitybar']")).toBeVisible();
	const activityButtons = sessionsPage.locator("[data-part='activitybar'] button");
	expect(await activityButtons.locator('svg').evaluateAll(icons => icons.map(icon => icon.getAttribute('data-ash-icon-id')))).toEqual(['chat-2-filled', 'colab', 'device-mobile', 'account']);
	await expect(sessionsPage.locator('.ash-sessions-activity-bottom button')).toHaveCount(2);
	const chatButton = activityButtons.first();
	const chatButtonBounds = await chatButton.boundingBox();
	const chatIconBounds = await chatButton.locator('svg').boundingBox();
	expect(chatButtonBounds).not.toBeNull();
	expect(chatIconBounds).not.toBeNull();
	expect(chatButtonBounds!.width).toBe(36);
	expect(chatButtonBounds!.height).toBe(36);
	expect(Math.abs(chatIconBounds!.x + chatIconBounds!.width / 2 - (chatButtonBounds!.x + chatButtonBounds!.width / 2))).toBeLessThanOrEqual(1);
	expect(Math.abs(chatIconBounds!.y + chatIconBounds!.height / 2 - (chatButtonBounds!.y + chatButtonBounds!.height / 2))).toBeLessThanOrEqual(1);
	await expect(activityButtons.nth(1)).toBeDisabled();
	await expect(activityButtons.nth(2)).toBeDisabled();
	if (target.appServerMode === 'required') {
		await activityButtons.nth(3).click();
		await expect(activityButtons.nth(3)).toHaveAttribute('aria-expanded', 'true');
		if (process.platform !== 'darwin') {
			await expect(sessionsPage.getByRole('menuitem', { name: 'Sign in with ChatGPT' })).toBeVisible();
		}
		await sessionsPage.keyboard.press('Escape');
	}
	await expect(sessionsPage.locator("[data-part='sidebar']")).toBeVisible();
	await expect(sessionsPage.locator("[data-part='sessions']")).toBeVisible();
	await expect(sessionsPage.locator("[data-part='auxiliarybar']")).toBeVisible();
	await expect(sessionsPage.locator(".ash-sessions-list")).toHaveCSS("display", "flex");
	await expect(sessionsPage.locator(".ash-sessions-chat-slot").first()).toHaveCSS("display", "flex");
	await expect(sessionsPage.locator(".ash-chat-input-part")).toBeVisible();
	const detailsToggle = sessionsPage.getByRole('button', { name: 'Session details' });
	await detailsToggle.click();
	await expect(sessionsPage.locator("[data-part='auxiliarybar']")).toBeHidden();
	await detailsToggle.click();
	await expect(sessionsPage.locator("[data-part='auxiliarybar']")).toBeVisible();
	const search = sessionsPage.getByRole('searchbox', { name: 'Search sessions' });
	await search.fill('no matching session title');
	await expect(sessionsPage.locator('.ash-sessions-empty')).toHaveText('No matching sessions');
	await search.clear();
	await sessionsPage.locator(".ash-sessions-titlebar-new-session").click();
	await expect(sessionsPage.locator(".ash-sessions-chat-slot")).toHaveCount(2);
	await expect(sessionsPage.locator(".ash-sessions-chat-slot.active")).toHaveCount(1);
	await sessionsPage.locator(".ash-sessions-chat-slot-close").last().click();
	await expect(sessionsPage.locator(".ash-sessions-chat-slot")).toHaveCount(1);
	await expect.poll(() => application.windows().length).toBe(2);

	const sessionWindowState = await application.evaluate(({ BrowserWindow }) => {
		const windows = BrowserWindow.getAllWindows();
		return windows.map((window: { readonly id: number; getTitle(): string; readonly webContents: { getURL(): string } }) => ({
			id: window.id,
			title: window.getTitle(),
			url: window.webContents.getURL(),
		}));
	});
	expect(sessionWindowState).toHaveLength(2);
	expect(sessionWindowState.some((window: { readonly url: string }) => window.url.includes("sessions-code.html"))).toBe(true);
	const windowIds = sessionWindowState.map((window: { readonly id: number }) => window.id).sort((left: number, right: number) => left - right);
	await openSessions.click();
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => window.id).sort((left, right) => left - right))).toEqual(windowIds);
	await sessionsPage.reload();
	await expect(sessionsPage.locator('.ash-code-sessions-window')).toBeVisible();
	await expect.poll(() => application.windows().length).toBe(2);
	const reloadedIpc = await sessionsPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		const configuration = await ipc.invoke('ash:configuration:read') as { readonly revision: number };
		const keybindings = await ipc.invoke('ash:keybindings-resource:read') as { readonly bindings: readonly unknown[] };
		const connection = await ipc.invoke('ash:remote:connection') as { readonly kind: string };
		let childCannotOpen = false;
		try { await ipc.invoke('ash:native-host:open-agents-window'); } catch { childCannotOpen = true; }
		return { configurationRevision: configuration.revision, bindings: keybindings.bindings.length, connectionKind: connection.kind, childCannotOpen };
	});
	expect(reloadedIpc).toEqual({ configurationRevision: expect.any(Number), bindings: expect.any(Number), connectionKind: 'local', childCannotOpen: true });
	await expect(workbenchPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return ipc.invoke('ash:sessions:return-to-workbench');
	})).rejects.toThrow(/Untrusted renderer IPC sender/);
	const expectedBounds = await application.evaluate(({ BrowserWindow }) => {
		const child = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('sessions-code.html'));
		if (!child) throw new Error('Sessions window is missing');
		child.setBounds({ ...child.getBounds(), width: 1000, height: 700 });
		return child.getBounds();
	});

	const closed = sessionsPage.waitForEvent("close");
	await sessionsPage.getByRole("button", { name: "Return to Workbench" }).click();
	await closed;
	await expect.poll(() => application.windows().length).toBe(1);
	await expect(workbenchPage.locator(".ash-workbench")).toBeVisible();
	await openSessions.click();
	await expect.poll(() => application.windows().length).toBe(2);
	const reopenedPage = application.windows().find(page => page !== workbenchPage);
	if (!reopenedPage) throw new Error('Reopened Sessions window is missing');
	await expect(reopenedPage.locator('.ash-code-sessions-window')).toBeVisible();
	await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
		const child = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('sessions-code.html'));
		return child?.getBounds();
	})).toEqual(expectedBounds);
	const reopenedClosed = reopenedPage.waitForEvent('close');
	await reopenedPage.getByRole('button', { name: 'Return to Workbench' }).click();
	await reopenedClosed;
	const parentClosed = workbenchPage.waitForEvent('close');
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
	await parentClosed;
});

test('Sessions details icon follows sidebar visibility', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const sessionsPagePromise = application.waitForEvent('window');
	await workbench.page.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
	const sessionsPage = await sessionsPagePromise;
	const detailsToggle = sessionsPage.getByRole('button', { name: 'Session details' });
	const auxiliaryBar = sessionsPage.locator("[data-part='auxiliarybar']");
	await expect(detailsToggle).toHaveAttribute('aria-pressed', /^(true|false)$/);
	if (await auxiliaryBar.isHidden()) {
		await detailsToggle.click();
	}
	await expect(auxiliaryBar).toBeVisible();
	await expect(detailsToggle.locator('svg[data-ash-icon-id="layout-sidebar-right-1"]')).toBeVisible();
	await detailsToggle.click();
	await expect(auxiliaryBar).toBeHidden();
	await expect(detailsToggle.locator('svg[data-ash-icon-id="layout-sidebar-right-off-1"]')).toBeVisible();
	const closed = sessionsPage.waitForEvent('close');
	await sessionsPage.getByRole('button', { name: 'Return to Workbench' }).click();
	await closed;
});

test('closing the Workbench keeps Sessions usable and Return to Workbench opens the workspace', async ({ target }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'This scenario requires Code Electron');
	const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-dedicated-close-'));
	try {
		const { application, driver, close } = await launchElectron({ appServerMode: target.appServerMode, workbenchMode: 'code', userDataDirectory });
		try {
			const parent = driver.workbench.page;
			const childPromise = application.waitForEvent('window');
			await parent.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
			const child = await childPromise;
			await expect(child.locator('.ash-code-sessions-window')).toBeVisible();
			await parent.close();
			await expect(child.locator('.ash-code-sessions-window')).toBeVisible();
			const windows = await child.evaluate(async () => {
				const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string, params?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
				const list = await ipc.invoke('ash:window:operation', { kind: 'list' }) as readonly { readonly title: string }[];
				const configuration = await ipc.invoke('ash:configuration:read') as { readonly revision: number };
				const connection = await ipc.invoke('ash:remote:connection') as { readonly kind: string };
				return { titles: list.map(window => window.title), configurationRevision: configuration.revision, connectionKind: connection.kind };
			});
			expect(windows).toEqual({ titles: [expect.stringContaining('Sessions')], configurationRevision: expect.any(Number), connectionKind: 'local' });
			const workbenchPromise = application.waitForEvent('window');
			await child.getByRole('button', { name: 'Return to Workbench' }).click();
			const reopened = await workbenchPromise;
			await expect(reopened.locator('.ash-workbench')).toBeVisible();
			await expect.poll(() => application.windows().length).toBe(1);
		} finally {
			await close();
		}
	} finally {
		if (!resolve(userDataDirectory).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('Test profile escaped the temporary directory');
		await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test('Code registers and releases a user system-wide Open Agents Window shortcut', async ({ target }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'This scenario requires Code Electron');
	const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-shortcut-'));
	const profileDirectory = join(userDataDirectory, 'profile');
	const resourcePath = join(profileDirectory, 'keybindings.json');
	await mkdir(profileDirectory);
	await writeFile(resourcePath, JSON.stringify([{
		key: 'ctrl+alt+shift+f24',
		command: 'workbench.action.openAgentsWindow',
		systemWide: true,
	}]));
	try {
		const { application, close } = await launchElectron({ appServerMode: 'disabled', workbenchMode: 'code', userDataDirectory, profileDirectory });
		try {
			await expect.poll(() => application.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+F24'))).toBe(true);
			await writeFile(resourcePath, '[]\n');
			await expect.poll(() => application.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Control+Alt+Shift+F24'))).toBe(false);
		} finally {
			await close();
		}
	} finally {
		if (!resolve(userDataDirectory).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('Test profile escaped the temporary directory');
		await rm(userDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
