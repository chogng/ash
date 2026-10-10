import type { IClipboardItem, IClipboardResources, IClipboardService } from '../common/clipboardService.js';
import { URI } from '../../../base/common/uri.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { getWindowById } from '../../../base/browser/window.js';

/** Browser Clipboard API adapter with explicit availability failure. */
export class BrowserClipboardService extends Disposable implements IClipboardService {
	// Browsers have no system find pasteboard; this term belongs to the window service scope.
	private findText = '';
	private readonly typedText = new Map<string, string>();
	private static readonly fileFormat = 'web application/x-ash-resources';
	constructor(private readonly clipboard: Clipboard | undefined) { super(); }

	public triggerPaste(targetWindowId: number): Promise<void> | undefined {
		const document = getWindowById(targetWindowId)?.window.document;
		if (!document || typeof document.execCommand !== 'function') {
			return undefined;
		}
		try {
			return document.execCommand('paste') ? Promise.resolve() : undefined;
		} catch {
			return undefined;
		}
	}

	public async read(): Promise<readonly IClipboardItem[]> {
		if (!this.clipboard) throw new Error('The browser clipboard is unavailable');
		if (typeof this.clipboard.read !== 'function') {
			return [{ type: 'text/plain', data: new TextEncoder().encode(await this.clipboard.readText()) }];
		}
		const result: IClipboardItem[] = [];
		for (const item of await this.clipboard.read()) {
			for (const type of item.types) {
				const blob = await item.getType(type);
				// Web custom formats carry a transport prefix, not part of the provider MIME type.
				result.push({ type: type.startsWith('web ') ? type.slice(4) : type, data: new Uint8Array(await blob.arrayBuffer()) });
			}
		}
		return result;
	}

	async readText(type?: string): Promise<string> {
		if (type) {
			return this.typedText.get(type) ?? '';
		}
		if (!this.clipboard) throw new Error('The browser clipboard is unavailable');
		return this.clipboard.readText();
	}

	async readImage(): Promise<Uint8Array> {
		if (!this.clipboard) throw new Error('The browser clipboard is unavailable');
		for (const item of await this.clipboard.read()) {
			if (item.types.includes('image/png')) return new Uint8Array(await (await item.getType('image/png')).arrayBuffer());
		}
		return new Uint8Array();
	}

	async writeText(value: string, type?: string): Promise<void> {
		if (type) {
			this.typedText.set(type, value);
			return;
		}
		if (!this.clipboard) throw new Error('The browser clipboard is unavailable');
		await this.clipboard.writeText(value);
	}

	async readFindText(): Promise<string> {
		return this.findText;
	}

	async writeFindText(text: string): Promise<void> {
		this.findText = text;
	}

	async readResources(): Promise<IClipboardResources> {
		if (!this.clipboard) throw new Error('The browser clipboard is unavailable');
		const item = (await this.clipboard.read())[0];
		if (!item?.types.includes(BrowserClipboardService.fileFormat)) return { resources: [], operation: 'copy' };
		const values: unknown = JSON.parse(await (await item.getType(BrowserClipboardService.fileFormat)).text());
		if (!values || typeof values !== 'object' || !('resources' in values) || !('operation' in values)
			|| !Array.isArray(values.resources) || !values.resources.every(value => typeof value === 'string')
			|| (values.operation !== 'copy' && values.operation !== 'move')) {
			throw new Error('Invalid file resources on the clipboard');
		}
		return { resources: values.resources.map(value => URI.parse(value)), operation: values.operation };
	}

	async writeResources(resources: readonly URI[], operation: 'copy' | 'move'): Promise<void> {
		if (!this.clipboard) throw new Error('The browser clipboard is unavailable');
		if (resources.length === 0) {
			await this.clipboard.writeText('');
			return;
		}
		await this.clipboard.write([new ClipboardItem({
			[BrowserClipboardService.fileFormat]: new Blob(
				[JSON.stringify({ resources: resources.map(resource => resource.toString()), operation })],
				{ type: 'application/x-ash-resources' },
			),
		})]);
	}

	async hasResources(): Promise<boolean> {
		return (await this.readResources()).resources.length > 0;
	}
}
