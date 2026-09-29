import { clipboard, ClipboardItem } from "electron";
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import type { IClipboardResources, IClipboardService } from '../common/clipboardService.js';

/** Electron main-process adapter for the system clipboard. */
export class ElectronMainClipboardService implements IClipboardService {
	private static readonly fileFormat = 'web application/x-ash-resources';

	async readText(): Promise<string> {
		return clipboard.readText();
	}

	async writeText(value: string): Promise<void> {
		await clipboard.writeText(value);
	}

	async readResources(): Promise<IClipboardResources> {
		const item = (await clipboard.read())[0];
		if (!item?.types.includes(ElectronMainClipboardService.fileFormat)) return { resources: [], operation: 'copy' };
		try {
			const blob = await item.getType(ElectronMainClipboardService.fileFormat);
			if (!(blob instanceof Blob)) return { resources: [], operation: 'copy' };
			const values: unknown = JSON.parse(await blob.text());
			if (!values || typeof values !== 'object' || !('resources' in values) || !('operation' in values)
				|| !Array.isArray(values.resources) || !values.resources.every(value => typeof value === 'string')
				|| (values.operation !== 'copy' && values.operation !== 'move')) return { resources: [], operation: 'copy' };
			return { resources: values.resources.map(value => URI.parse(value)), operation: values.operation };
		} catch {
			return { resources: [], operation: 'copy' };
		}
	}

	async writeResources(resources: readonly URI[], operation: 'copy' | 'move'): Promise<void> {
		if (resources.length === 0) {
			clipboard.clear();
			return;
		}
		const formats: Record<string, string | Blob> = {
			[ElectronMainClipboardService.fileFormat]: JSON.stringify({ resources: resources.map(resource => resource.toString()), operation }),
		};
		const localFiles = resources.filter(resource => resource.scheme === Schemas.file);
		if (localFiles.length > 0) {
			formats['text/uri-list'] = localFiles.map(resource => resource.toString()).join('\r\n');
			if (process.platform === 'win32') {
				// Explorer reads this DWORD alongside CF_HDROP to distinguish Cut from Copy.
				formats['electron application/osclipboard;format="Preferred DropEffect"'] = new Blob([Uint8Array.of(operation === 'move' ? 2 : 1, 0, 0, 0)]);
			}
		}
		await clipboard.write([new ClipboardItem(formats)]);
	}

	async hasResources(): Promise<boolean> {
		return clipboard.has(ElectronMainClipboardService.fileFormat);
	}
}
