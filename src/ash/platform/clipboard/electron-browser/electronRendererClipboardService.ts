import { URI } from '../../../base/common/uri.js';
import { invoke } from '../../ipc/electron-browser/rendererIpc.js';
import type { IClipboardItem, IClipboardResources, IClipboardService } from '../common/clipboardService.js';
import { getWindowById, mainWindow } from '../../../base/browser/window.js';

/** Reads and writes the shared desktop clipboard through Electron Main. */
export class ElectronRendererClipboardService implements IClipboardService {
	public triggerPaste(targetWindowId: number): Promise<void> | undefined {
		const target = getWindowById(targetWindowId)?.window;
		if (!target || target.closed) return undefined;
		if (target !== mainWindow) {
			return invoke<void>('ash:host:triggerPaste', { windowName: target.name });
		}
		// DOM IDs are realm-local; Main resolves only this sender's registered windows.
		return invoke<void>('ash:host:triggerPaste');
	}

	public read(): Promise<readonly IClipboardItem[]> {
		return invoke<readonly IClipboardItem[]>('ash:host:readClipboardData');
	}

	public readText(type?: string): Promise<string> {
		return invoke<string>('ash:host:readClipboard', type);
	}

	public readImage(): Promise<Uint8Array> {
		return invoke<Uint8Array>('ash:host:readClipboardImage');
	}

	public writeText(value: string, type?: string): Promise<void> {
		return invoke<void>('ash:host:writeClipboard', type ? { text: value, type } : value);
	}

	public readFindText(): Promise<string> {
		return invoke<string>('ash:host:readFindClipboard');
	}

	public writeFindText(text: string): Promise<void> {
		return invoke<void>('ash:host:writeFindClipboard', text);
	}

	public async readResources(): Promise<IClipboardResources> {
		const { resources, operation } = await invoke<{ resources: string[]; operation: 'copy' | 'move'; }>('ash:host:readClipboardResources');
		return { resources: resources.map(value => URI.parse(value)), operation };
	}

	public writeResources(resources: readonly URI[], operation: 'copy' | 'move'): Promise<void> {
		return invoke<void>('ash:host:writeClipboardResources', { resources: resources.map(resource => resource.toString()), operation });
	}

	public hasResources(): Promise<boolean> {
		return invoke<boolean>('ash:host:hasClipboardResources');
	}
}
