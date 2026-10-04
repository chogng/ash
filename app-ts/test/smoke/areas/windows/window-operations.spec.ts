import { waitForElectronWindowState } from "../../../automation/electronDriver.js";
import { expect, test } from '../../../automation/test.js';

for (const windowKind of ['Workbench', 'Agents'] as const) {
	test(`Electron ${windowKind} window operations use the registered window host`, async ({ application, target, workbench }) => {
		test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'This scenario requires the Code Electron Workbench');
		if (!('windows' in application)) throw new Error('Expected Electron windows');
		const page = windowKind === 'Agents' ? await workbench.openAgentsWindow(target.kind) : workbench.page;
		const windowHandle = await application.browserWindow(page);
		const windowId = await windowHandle.evaluate(window => window.id);
		const result = await page.evaluate(async windowId => {
			const bridge = (globalThis as unknown as {
				readonly ash: { readonly ipcRenderer: {
					invoke(channel: string, params: unknown): Promise<unknown>;
					on(channel: string, listener: (value: unknown) => void): { dispose(): void };
				} };
			}).ash.ipcRenderer;
			const channel = 'ash:window:operation';
			const windows = await bridge.invoke(channel, { kind: 'list' }) as readonly { readonly id: number; readonly focused: boolean }[];
			const focused = windows.find(window => window.id === windowId);
			if (!focused) throw new Error('Caller window is missing from the window list');
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
		}, windowId);

		expect(result).toEqual({ count: windowKind === 'Agents' ? 2 : 1, focused: true, zoomNotification: 1, changedZoom: 1, changedAlwaysOnTop: true, zoom: 0, alwaysOnTop: false, rejected: true });
	});
}

test('window picker data includes the Agents window and can focus it', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron' || target.workbenchMode !== 'code', 'This scenario requires the Code Electron Workbench');
	if (target.kind !== 'electron' || !('windows' in application)) return;
	const opened = application.waitForEvent('window');
	await workbench.page.keyboard.press('F1');
	await workbench.page.locator('.ash-quick-pick').getByRole('combobox').fill('Open Agents Window');
	await workbench.page.keyboard.press('Enter');
	const childPage = await opened;
	try {
		const agentsWindow = await application.browserWindow(childPage);
		const agentsWindowId = await agentsWindow.evaluate(window => window.id);
		await waitForElectronWindowState(application, childPage, { focused: true });
		const windows = await workbench.page.evaluate(async () => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, params: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			return ipc.invoke('ash:window:operation', { kind: 'list' }) as Promise<readonly { id: number; focused: boolean }[]>;
		});
		expect(windows).toHaveLength(2);
		const agents = windows.find(window => window.id === agentsWindowId);
		const workbenchWindow = windows.find(window => window.id !== agents?.id);
		expect(agents).toBeDefined();
		expect(agents!.focused).toBe(true);
		expect(workbenchWindow).toBeDefined();
		await workbench.page.evaluate(async id => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, params: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			await ipc.invoke('ash:window:operation', { kind: 'focus', windowId: id });
		}, workbenchWindow!.id);
		await waitForElectronWindowState(application, workbench.page, { focused: true });
		await workbench.page.evaluate(async id => {
			const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, params: unknown): Promise<unknown> } } }).ash.ipcRenderer;
			await ipc.invoke('ash:window:operation', { kind: 'focus', windowId: id });
		}, agents!.id);
		await waitForElectronWindowState(application, childPage, { focused: true });
		await expect(childPage.locator('.ash-sessions-window')).toBeVisible();
	} finally {
		if (!childPage.isClosed()) await childPage.close();
	}
});
