import { expect, test } from "../../../automation/test.js";
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { launchElectron } from '../../../automation/playwrightElectron.js';

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
		const windows = await ipc.invoke('ash:window:operation', { kind: 'list' }) as readonly { readonly id: number; readonly parentId?: number }[];
		const child = windows.find(window => window.parentId !== undefined);
		if (!child) throw new Error('Dedicated window is missing from window list');
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
		return { count: windows.length, childParentId: child.parentId, changedZoom, zoom };
	});
	expect(childWindowOperations).toEqual({ count: 2, childParentId: expect.any(Number), changedZoom: 1, zoom: 1 });
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
	await expect(sessionsPage.locator("[data-part='titlebar']")).toBeVisible();
	await expect(sessionsPage.locator("[data-part='sidebar']")).toBeVisible();
	await expect(sessionsPage.locator("[data-part='sessions']")).toBeVisible();
	await expect(sessionsPage.locator("[data-part='auxiliarybar']")).toBeVisible();
	await expect(sessionsPage.locator(".ash-sessions-list")).toHaveCSS("display", "flex");
	await expect(sessionsPage.locator(".ash-sessions-chat-slot").first()).toHaveCSS("display", "flex");
	await expect(sessionsPage.locator(".ash-chat-input-part")).toBeVisible();
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
		try { await ipc.invoke('ash:dedicated-window:open'); } catch { childCannotOpen = true; }
		return { configurationRevision: configuration.revision, bindings: keybindings.bindings.length, connectionKind: connection.kind, childCannotOpen };
	});
	expect(reloadedIpc).toEqual({ configurationRevision: expect.any(Number), bindings: expect.any(Number), connectionKind: 'local', childCannotOpen: true });
	await expect(workbenchPage.evaluate(async () => {
		const ipc = (globalThis as unknown as { readonly ash: { readonly ipcRenderer: { invoke(channel: string): Promise<unknown> } } }).ash.ipcRenderer;
		return ipc.invoke('ash:dedicated-window:return-to-parent');
	})).rejects.toThrow(/Untrusted renderer IPC sender/);

	const closed = sessionsPage.waitForEvent("close");
	await sessionsPage.getByRole("button", { name: "Workbench" }).click();
	await closed;
	await expect.poll(() => application.windows().length).toBe(1);
	await expect(workbenchPage.locator(".ash-workbench")).toBeVisible();
	const parentClosed = workbenchPage.waitForEvent('close');
	await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
	await parentClosed;
});

test('closing the parent Workbench closes its dedicated Sessions window', async ({ target }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'This scenario requires Code Electron');
	const userDataDirectory = await mkdtemp(join(tmpdir(), 'ash-dedicated-close-'));
	try {
		const { application, driver, close } = await launchElectron({ appServerMode: 'disabled', workbenchMode: 'code', userDataDirectory });
		try {
			const parent = driver.workbench.page;
			const childPromise = application.waitForEvent('window');
			await parent.locator("[data-action-id='workbench.action.chat.openAgentsWindow.titleBar'] button").click();
			const child = await childPromise;
			await expect(child.locator('.ash-code-sessions-window')).toBeVisible();
			const childClosed = child.waitForEvent('close');
			await parent.close();
			await childClosed;
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
