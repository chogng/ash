import type { IAuxiliaryWindowsMainService } from '../../auxiliaryWindow/electron-main/auxiliaryWindows.js';
import { collectElectronMemory } from '../../memory/electron-main/electronMemoryCollector.js';
import { URI } from '../../../base/common/uri.js';
import type { BrowserWindow } from 'electron/main';
import { ElectronMainClipboardService } from '../../clipboard/electron-main/electronMainClipboardService.js';
import { ElectronOpenerService } from '../../opener/electron-main/electronOpenerService.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import type { DialogRequest } from '../../dialogs/common/dialogs.js';

export function rendererSystemHostRoutes(
	window: BrowserWindow,
	directoryPermissionPrompt: (path: string) => DialogRequest,
	auxiliaryWindows: IAuxiliaryWindowsMainService,
): readonly IpcRoute<unknown, unknown>[] {
	const clipboard = new ElectronMainClipboardService(window);
	const opener = new ElectronOpenerService();
	const text = (value: unknown): string => { if (typeof value !== 'string' || value.length > 1_000_000) { throw new Error('Invalid host text'); } return value; };
	const clipboardType = (value: unknown): 'clipboard' | 'selection' | undefined => {
		if (value !== undefined && value !== 'clipboard' && value !== 'selection') {
			throw new TypeError('Invalid clipboard type');
		}
		return value;
	};
	const clipboardWrite = (value: unknown): { text: string; type: 'clipboard' | 'selection' | undefined; } => {
		if (typeof value === 'string') {
			return { text: text(value), type: undefined };
		}
		if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'text' && key !== 'type') || !('text' in value)) {
			throw new TypeError('Invalid clipboard text write');
		}
		return { text: text(value.text), type: clipboardType('type' in value ? value.type : undefined) };
	};
	const resourceWrite = (value: unknown): { resources: string[]; operation: 'copy' | 'move'; } => {
		if (!value || typeof value !== 'object' || !('resources' in value) || !('operation' in value)) throw new Error('Invalid clipboard resources');
		const { resources, operation } = value;
		if (!Array.isArray(resources) || resources.length > 1024 || !resources.every(item => typeof item === 'string' && item.length <= 8192) || (operation !== 'copy' && operation !== 'move')) throw new Error('Invalid clipboard resources');
		return { resources, operation };
	};
	return [
		{ channel: 'ash:memory:collect', validate: value => { if (value !== undefined) { throw new Error('Unexpected memory collection arguments'); } }, invoke: () => collectElectronMemory(window) },
		{ channel: 'ash:host:openExternal', validate: text, invoke: value => opener.openExternal(value as string) },
		{
			channel: 'ash:host:triggerPaste',
			validate: value => {
				if (value === undefined) return undefined;
				if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('windowName' in value)
					|| typeof value.windowName !== 'string' || !/^ash-auxiliary-[0-9a-f-]{36}$/.test(value.windowName)) {
					throw new TypeError('Invalid paste target');
				}
				return value.windowName;
			},
			invoke: async value => {
				if (value === undefined) return clipboard.triggerPaste(window.id);
				// A renderer can select only a live auxiliary window registered under its own workbench.
				const target = auxiliaryWindows.getWindows().find(candidate => candidate.parentId === window.id && candidate.win.webContents.mainFrame.name === value);
				if (!target) throw new Error('The paste target window is unavailable');
				await new ElectronMainClipboardService(target.win).triggerPaste(target.id);
			},
		},
		{ channel: 'ash:host:readClipboard', validate: clipboardType, invoke: value => clipboard.readText(value as ReturnType<typeof clipboardType>) },
		{ channel: 'ash:host:readClipboardData', validate: value => { if (value !== undefined) throw new Error('Unexpected clipboard arguments'); }, invoke: () => clipboard.read() },
		{ channel: 'ash:host:readClipboardImage', validate: value => { if (value !== undefined) throw new Error('Unexpected clipboard arguments'); }, invoke: () => clipboard.readImage() },
		{
			channel: 'ash:host:screenshot', validate: value => { if (value !== undefined) throw new Error('Unexpected screenshot arguments'); }, invoke: async () => {
				// The trusted router binds this route to its sender; another window can never be chosen by renderer input.
				if (window.isDestroyed() || window.webContents.isDestroyed()) throw new Error('The screenshot window has closed');
				return new Uint8Array((await window.webContents.capturePage()).toPNG());
			}
		},
		{ channel: 'ash:host:readFindClipboard', validate: value => { if (value !== undefined) throw new Error('Unexpected find clipboard arguments'); }, invoke: () => clipboard.readFindText() },
		{ channel: 'ash:host:writeFindClipboard', validate: text, invoke: value => clipboard.writeFindText(value as string) },
		{
			channel: 'ash:host:writeClipboard', validate: clipboardWrite, invoke: value => {
				const { text, type } = value as ReturnType<typeof clipboardWrite>;
				return clipboard.writeText(text, type);
			}
		},
		{
			channel: 'ash:host:readClipboardResources', validate: value => { if (value !== undefined) throw new Error('Unexpected clipboard arguments'); }, invoke: async () => {
				const { resources, operation } = await clipboard.readResources();
				return { resources: resources.map(resource => resource.toString()), operation };
			}
		},
		{
			channel: 'ash:host:writeClipboardResources', validate: resourceWrite, invoke: value => {
				const { resources, operation } = value as ReturnType<typeof resourceWrite>;
				return clipboard.writeResources(resources.map(uri => URI.parse(uri)), operation);
			}
		},
		{ channel: 'ash:host:hasClipboardResources', validate: value => { if (value !== undefined) throw new Error('Unexpected clipboard arguments'); }, invoke: () => clipboard.hasResources() },
		{ channel: 'ash:host:directoryPermissionPrompt', validate: text, invoke: value => directoryPermissionPrompt(value as string) },
	];
}
