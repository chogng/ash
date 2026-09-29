import { URI } from '../../../base/common/uri.js';
import { invoke } from '../../ipc/electron-browser/rendererIpc.js';
import type { IClipboardService } from '../common/clipboardService.js';

/** Reads and writes the shared desktop clipboard through Electron Main. */
export class ElectronBrowserClipboardService implements IClipboardService {
	public readText(): Promise<string> {
		return invoke<string>('ash:host:readClipboard');
	}

	public writeText(value: string): Promise<void> {
		return invoke<void>('ash:host:writeClipboard', value);
	}

	public async readResources(): Promise<readonly URI[]> {
		return (await invoke<string[]>('ash:host:readClipboardResources')).map(value => URI.parse(value));
	}

	public writeResources(resources: readonly URI[]): Promise<void> {
		return invoke<void>('ash:host:writeClipboardResources', resources.map(resource => resource.toString()));
	}

	public hasResources(): Promise<boolean> {
		return invoke<boolean>('ash:host:hasClipboardResources');
	}
}
