import { clipboard } from "electron";
import { URI } from '../../../base/common/uri.js';
import type { IClipboardService } from '../common/clipboardService.js';

/** Electron main-process adapter for the system clipboard. */
export class ElectronClipboardService implements IClipboardService {
	private static readonly fileFormat = 'ash/file-list';

	async readText(): Promise<string> {
		return clipboard.readText();
	}

	async writeText(value: string): Promise<void> {
		clipboard.writeText(value);
	}

	async readResources(): Promise<readonly URI[]> {
		const data = clipboard.readBuffer(ElectronClipboardService.fileFormat).toString('utf8');
		if (!data) return [];
		try {
			const values: unknown = JSON.parse(data);
			if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) return [];
			return values.map(value => URI.parse(value));
		} catch {
			return [];
		}
	}

	async writeResources(resources: readonly URI[]): Promise<void> {
		if (resources.length === 0) {
			clipboard.clear();
			return;
		}
		clipboard.writeBuffer(ElectronClipboardService.fileFormat, Buffer.from(JSON.stringify(resources.map(resource => resource.toString()))));
	}

	async hasResources(): Promise<boolean> {
		return clipboard.has(ElectronClipboardService.fileFormat);
	}
}
