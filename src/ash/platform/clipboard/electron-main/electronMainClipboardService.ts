import { clipboard, ClipboardItem } from "electron";
import type { BrowserWindow } from 'electron/main';
import { Schemas } from '../../../base/common/network.js';
import { URI } from '../../../base/common/uri.js';
import type { IClipboardItem, IClipboardResources, IClipboardService } from '../common/clipboardService.js';

/** Electron main-process adapter for the system clipboard. */
export class ElectronMainClipboardService implements IClipboardService {
	private static readonly fileFormat = 'web application/x-ash-resources';
	constructor(private readonly window: BrowserWindow) { }

	async triggerPaste(targetWindowId: number): Promise<void> {
		if (targetWindowId !== this.window.id || this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
			throw new Error('The paste target window is unavailable');
		}
		this.window.webContents.paste();
	}

	public async read(): Promise<readonly IClipboardItem[]> {
		const result: IClipboardItem[] = [];
		for (const item of await clipboard.read()) {
			for (const type of item.types) {
				const blob = await item.getType(type);
				if (blob instanceof Blob) {
					result.push({ type: type.startsWith('web ') ? type.slice(4) : type, data: new Uint8Array(await blob.arrayBuffer()) });
				}
			}
		}
		return result;
	}

	async readText(type?: string): Promise<string> {
		if (type === 'selection') {
			return process.platform === 'linux' ? clipboard.selection.readText() : '';
		}
		return clipboard.readText();
	}

	async readImage(): Promise<Uint8Array> {
		for (const item of await clipboard.read()) {
			if (!item.types.includes('image/png')) continue;
			const image = await item.getType('image/png');
			if (image instanceof Blob) return new Uint8Array(await image.arrayBuffer());
		}
		return new Uint8Array();
	}

	async writeText(value: string, type?: string): Promise<void> {
		if (type === 'selection') {
			if (process.platform === 'linux') {
				await clipboard.selection.writeText(value);
			}
			return;
		}
		await clipboard.writeText(value);
	}

	async readFindText(): Promise<string> {
		if (process.platform !== 'darwin') return '';
		for (const item of await clipboard.read()) {
			if (!item.types.includes('electron application/findtext')) continue;
			const term = await item.getType('electron application/findtext');
			if (term instanceof Blob) return term.text();
		}
		return '';
	}

	async writeFindText(text: string): Promise<void> {
		if (process.platform !== 'darwin') return;
		await clipboard.write([new ClipboardItem({ 'electron application/findtext': text })]);
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
			const fileUrls = localFiles.map(resource => resource.toString());
			formats['text/uri-list'] = fileUrls.join('\r\n');
			if (process.platform === 'win32') {
				// Explorer reads this DWORD alongside CF_HDROP to distinguish Cut from Copy.
				formats['electron application/osclipboard;format="Preferred DropEffect"'] = new Blob([Uint8Array.of(operation === 'move' ? 2 : 1, 0, 0, 0)]);
			} else if (process.platform === 'linux') {
				// GNOME and KDE use different cut markers alongside text/uri-list.
				formats['electron application/osclipboard;format="x-special/gnome-copied-files"'] = `${operation === 'move' ? 'cut' : 'copy'}\n${fileUrls.join('\n')}`;
				formats['electron application/osclipboard;format="application/x-kde-cutselection"'] = operation === 'move' ? '1' : '0';
			}
		}
		await clipboard.write([new ClipboardItem(formats)]);
	}

	async hasResources(): Promise<boolean> {
		return clipboard.has(ElectronMainClipboardService.fileFormat);
	}
}
