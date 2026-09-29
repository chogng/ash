import { collectElectronMemory } from '../../memory/electron-main/electronMemoryCollector.js';
import { URI } from '../../../base/common/uri.js';
import type { BrowserWindow } from 'electron/main';
import { ElectronClipboardService } from '../../clipboard/electron-main/electronClipboardService.js';
import { ElectronOpenerService } from '../../opener/electron-main/electronOpenerService.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import type { DialogRequest } from '../../dialogs/common/dialogs.js';

export function rendererSystemHostRoutes(
	window: BrowserWindow,
	directoryPermissionPrompt: (path: string) => DialogRequest,
): readonly IpcRoute<unknown, unknown>[] {
	const clipboard = new ElectronClipboardService();
	const opener = new ElectronOpenerService();
	const text = (value: unknown): string => { if (typeof value !== 'string' || value.length > 1_000_000) { throw new Error('Invalid host text'); } return value; };
	const resourceWrite = (value: unknown): { resources: string[]; operation: 'copy' | 'move' } => {
		if (!value || typeof value !== 'object' || !('resources' in value) || !('operation' in value)) throw new Error('Invalid clipboard resources');
		const { resources, operation } = value;
		if (!Array.isArray(resources) || resources.length > 1024 || !resources.every(item => typeof item === 'string' && item.length <= 8192) || (operation !== 'copy' && operation !== 'move')) throw new Error('Invalid clipboard resources');
		return { resources, operation };
	};
	return [
		{ channel: 'ash:memory:collect', validate: value => { if (value !== undefined) { throw new Error('Unexpected memory collection arguments'); } }, invoke: () => collectElectronMemory(window) },
		{ channel: 'ash:host:openExternal', validate: text, invoke: value => opener.openExternal(value as string) },
		{ channel: 'ash:host:readClipboard', validate: value => { if (value !== undefined) { throw new Error('Unexpected clipboard arguments'); } }, invoke: () => clipboard.readText() },
		{ channel: 'ash:host:writeClipboard', validate: text, invoke: value => clipboard.writeText(value as string) },
		{ channel: 'ash:host:readClipboardResources', validate: value => { if (value !== undefined) throw new Error('Unexpected clipboard arguments'); }, invoke: async () => {
			const { resources, operation } = await clipboard.readResources();
			return { resources: resources.map(resource => resource.toString()), operation };
		} },
		{ channel: 'ash:host:writeClipboardResources', validate: resourceWrite, invoke: value => {
			const { resources, operation } = value as ReturnType<typeof resourceWrite>;
			return clipboard.writeResources(resources.map(uri => URI.parse(uri)), operation);
		} },
		{ channel: 'ash:host:hasClipboardResources', validate: value => { if (value !== undefined) throw new Error('Unexpected clipboard arguments'); }, invoke: () => clipboard.hasResources() },
		{ channel: 'ash:host:directoryPermissionPrompt', validate: text, invoke: value => directoryPermissionPrompt(value as string) },
	];
}
