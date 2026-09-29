import { URI } from '../../../base/common/uri.js';
import { invoke } from '../../ipc/electron-browser/rendererIpc.js';
import type { IClipboardResources, IClipboardService } from '../common/clipboardService.js';

/** Reads and writes the shared desktop clipboard through Electron Main. */
export class ElectronRendererClipboardService implements IClipboardService {
	public readText(): Promise<string> {
		return invoke<string>('ash:host:readClipboard');
	}

	public writeText(value: string): Promise<void> {
		return invoke<void>('ash:host:writeClipboard', value);
	}

	public async readResources(): Promise<IClipboardResources> {
		const { resources, operation } = await invoke<{ resources: string[]; operation: 'copy' | 'move' }>('ash:host:readClipboardResources');
		return { resources: resources.map(value => URI.parse(value)), operation };
	}

	public writeResources(resources: readonly URI[], operation: 'copy' | 'move'): Promise<void> {
		return invoke<void>('ash:host:writeClipboardResources', { resources: resources.map(resource => resource.toString()), operation });
	}

	public hasResources(): Promise<boolean> {
		return invoke<boolean>('ash:host:hasClipboardResources');
	}
}
