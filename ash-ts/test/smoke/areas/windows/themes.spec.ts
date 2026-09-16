import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test('Desktop migrates a user theme through the file provider and applies its colors', async ({ application, target, workbench }) => {
	test.skip(target.kind !== 'electron', 'Requires the desktop profile file provider');
	if (!('windows' in application)) return;
	const hasOverlay = await application.evaluate(({ BrowserWindow }) => {
		const state = globalThis as unknown as { themeUpdates: { color?: string; symbolColor?: string }[] };
		state.themeUpdates = [];
		if (process.platform === 'darwin') return false;
		const window = BrowserWindow.getAllWindows()[0]!;
		const setOverlay = window.setTitleBarOverlay.bind(window);
		window.setTitleBarOverlay = options => {
			state.themeUpdates.push({ color: options.color, symbolColor: options.symbolColor });
			setOverlay(options);
		};
		return true;
	});
	const home = await application.evaluate(() => process.env.ASH_HOME!);
	await mkdir(join(home, 'themes'), { recursive: true });
	await writeFile(join(home, 'themes', 'test-migration.json'), JSON.stringify({ version: 1, id: 'test-migration', label: 'Test Migration', colorScheme: 'dark', colors: { 'editor.background': '#123456', 'titleBar.background': '#18293a', 'titleBar.actionForeground': '#fedcba' } }));
	await workbench.page.reload();
	await workbench.waitForReady();
	const source = JSON.parse(await readFile(join(home, 'themes', 'test-migration.json'), 'utf8'));
	expect(source.name).toBe('Test Migration');
	expect(source.version).toBeUndefined();
	await workbench.page.evaluate(async () => {
		const ipc = (globalThis as unknown as { ash: { ipcRenderer: { invoke(channel: string, args?: unknown): Promise<unknown> } } }).ash.ipcRenderer;
		const snapshot = await ipc.invoke('ash:configuration:read') as { revision: number; document: { source: string } };
		const values = JSON.parse(snapshot.document.source);
		values['workbench.colorTheme'] = 'test-migration';
		await ipc.invoke('ash:configuration:update', { expectedRevision: snapshot.revision, document: { version: 1, source: JSON.stringify(values) } });
	});
	await expect.poll(() => workbench.element.evaluate(element => getComputedStyle(element).getPropertyValue('--ash-editor-background').trim())).toBe('#123456');
	if (hasOverlay) {
		await expect.poll(() => application.evaluate(() => (globalThis as unknown as { themeUpdates: { color?: string; symbolColor?: string }[] }).themeUpdates.at(-1))).toEqual({ color: '#18293a', symbolColor: '#fedcba' });
	}
});
