import { expect, test } from '../../../automation/test.js';

test('Electron Workbench window operations use the registered window host', async ({ target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'This scenario requires the Code Electron Workbench');
	const result = await workbench.page.evaluate(async () => {
		const bridge = (globalThis as unknown as {
			readonly ash: { readonly ipcRenderer: {
				invoke(channel: string, params: unknown): Promise<unknown>;
				on(channel: string, listener: (value: unknown) => void): { dispose(): void };
			} };
		}).ash.ipcRenderer;
		const channel = 'ash:window:operation';
		const windows = await bridge.invoke(channel, { kind: 'list' }) as readonly { readonly id: number; readonly focused: boolean }[];
		const focused = windows.find(window => window.focused);
		if (!focused) throw new Error('No focused Workbench window');
		await bridge.invoke(channel, { kind: 'focus', windowId: focused.id });
		const zoomChanged = new Promise<number>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('Zoom notification was not delivered')), 2_000);
			const subscription = bridge.on('ash:window:zoom-changed', value => {
				clearTimeout(timeout);
				subscription.dispose();
				resolve(value as number);
			});
		});
		await bridge.invoke(channel, { kind: 'setZoom', level: 1 });
		const zoomNotification = await zoomChanged;
		const changedZoom = await bridge.invoke(channel, { kind: 'getZoom' });
		await bridge.invoke(channel, { kind: 'setZoom', level: 0 });
		await bridge.invoke(channel, { kind: 'setAlwaysOnTop', enabled: true });
		const changedAlwaysOnTop = await bridge.invoke(channel, { kind: 'getAlwaysOnTop' });
		await bridge.invoke(channel, { kind: 'setAlwaysOnTop', enabled: false });
		const zoom = await bridge.invoke(channel, { kind: 'getZoom' });
		const alwaysOnTop = await bridge.invoke(channel, { kind: 'getAlwaysOnTop' });
		let rejected = false;
		try {
			await bridge.invoke(channel, { kind: 'focus', windowId: -1 });
		} catch {
			rejected = true;
		}
		return { count: windows.length, focused: (await bridge.invoke(channel, { kind: 'list' }) as typeof windows).some(window => window.id === focused.id && window.focused), zoomNotification, changedZoom, changedAlwaysOnTop, zoom, alwaysOnTop, rejected };
	});

	expect(result).toEqual({ count: 1, focused: true, zoomNotification: 1, changedZoom: 1, changedAlwaysOnTop: true, zoom: 0, alwaysOnTop: false, rejected: true });
});

test('window picker data includes the Agents child window and can focus it', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'This scenario requires the Code Electron Workbench');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const opened = application.waitForEvent('window');
	await workbench.page.keyboard.press('F1');
	await workbench.page.locator('.ash-quick-pick').getByRole('combobox').fill('Open Agents Window');
	await workbench.page.keyboard.press('Enter');
	const childPage = await opened;
	try {
		const windows = await workbench.page.evaluate(async () => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, params: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			return ipc.invoke('ash:window:operation', { kind: 'list' }) as Promise<readonly { id: number; parentId?: number }[]>;
		});
		expect(windows).toHaveLength(2);
		const child = windows.find(window => window.parentId !== undefined);
		expect(child?.parentId).toBe(windows.find(window => window.parentId === undefined)?.id);
		await workbench.page.evaluate(async id => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, params: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			await ipc.invoke('ash:window:operation', { kind: 'focus', windowId: id });
		}, child!.id);
		await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id)).toBe(child!.id);
		await expect(childPage.locator('.ash-sessions-window')).toBeVisible();
		await childPage.keyboard.press('ControlOrMeta+Alt+w');
		await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id)).toBe(child!.parentId);
		await workbench.page.keyboard.press('ControlOrMeta+Alt+w');
		await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id)).toBe(child!.id);
	} finally {
		if (!childPage.isClosed()) await childPage.close();
	}
});
