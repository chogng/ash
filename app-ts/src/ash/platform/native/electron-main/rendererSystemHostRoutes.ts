import { collectElectronMemory } from '../../memory/electron-main/electronMemoryCollector.js';
import { dialog } from 'electron/main';
import type { BrowserWindow } from 'electron/main';
import { ElectronClipboardService } from '../../clipboard/electron-main/electronClipboardService.js';
import { ElectronOpenerService } from '../../opener/electron-main/electronOpenerService.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';

export function rendererSystemHostRoutes(window: BrowserWindow): readonly IpcRoute<unknown, unknown>[] {
	const clipboard = new ElectronClipboardService();
	const opener = new ElectronOpenerService();
	const text = (value: unknown): string => { if (typeof value !== 'string' || value.length > 1_000_000) { throw new Error('Invalid host text'); } return value; };
	return [
		{ channel: 'ash:memory:collect', validate: value => { if (value !== undefined) { throw new Error('Unexpected memory collection arguments'); } }, invoke: () => collectElectronMemory(window) },
		{ channel: 'ash:host:openExternal', validate: text, invoke: value => opener.openExternal(value as string) },
		{ channel: 'ash:host:readClipboard', validate: value => { if (value !== undefined) { throw new Error('Unexpected clipboard arguments'); } }, invoke: () => clipboard.readText() },
		{ channel: 'ash:host:writeClipboard', validate: text, invoke: value => clipboard.writeText(value as string) },
		{ channel: 'ash:host:selectDirectoryPermissions', validate: text, invoke: async value => {
			const result = await dialog.showMessageBox(window, {
				type: 'question', buttons: ['Allow Development Features', 'Read Only', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
				message: 'Which capabilities should this directory receive?',
				detail: `${value}\nDevelopment features allow file changes, commands, repository mutations, language services, and directory-provided configuration. Read Only allows browsing, searching, watching, and repository inspection.`,
			});
			return result.response;
		} },
	];
}
