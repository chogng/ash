import { clipboard, ClipboardItem } from "electron";
import { URI } from '../../../base/common/uri.js';
import type { IClipboardService } from '../common/clipboardService.js';

/** Electron main-process adapter for the system clipboard. */
export class ElectronClipboardService implements IClipboardService {
	private static readonly fileFormat = 'web application/x-ash-resources';

	async readText(): Promise<string> {
		return clipboard.readText();
	}

	async writeText(value: string): Promise<void> {
		await clipboard.writeText(value);
	}

	async readResources(): Promise<readonly URI[]> {
		const item = (await clipboard.read())[0];
		if (!item?.types.includes(ElectronClipboardService.fileFormat)) return [];
		try {
			const blob = await item.getType(ElectronClipboardService.fileFormat);
			if (!(blob instanceof Blob)) return [];
			const values: unknown = JSON.parse(await blob.text());
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
		const localFiles = resources.filter(resource => resource.scheme === 'file');
		await clipboard.write([new ClipboardItem({
			[ElectronClipboardService.fileFormat]: JSON.stringify(resources.map(resource => resource.toString())),
			...(localFiles.length ? { 'text/uri-list': localFiles.map(resource => resource.toString()).join('\r\n') } : {}),
		})]);
	}

	async hasResources(): Promise<boolean> {
		return clipboard.has(ElectronClipboardService.fileFormat);
	}
}
