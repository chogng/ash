import type { IClipboardService } from '../common/clipboardService.js';
import { URI } from '../../../base/common/uri.js';

/** Browser Clipboard API adapter with explicit availability failure. */
export class BrowserClipboardService implements IClipboardService {
	private static readonly fileFormat = 'web application/x-ash-resources';
	constructor(private readonly clipboard: Clipboard | undefined) {}

	async readText(): Promise<string> {
		if (!this.clipboard) throw new Error('The browser clipboard is unavailable');
		return this.clipboard.readText();
	}

	async writeText(value: string): Promise<void> {
		if (!this.clipboard) throw new Error('The browser clipboard is unavailable');
		await this.clipboard.writeText(value);
	}

	async readResources(): Promise<readonly URI[]> {
		if (!this.clipboard) throw new Error('The browser clipboard is unavailable');
		const item = (await this.clipboard.read())[0];
		if (!item?.types.includes(BrowserClipboardService.fileFormat)) return [];
		const values: unknown = JSON.parse(await (await item.getType(BrowserClipboardService.fileFormat)).text());
		if (!Array.isArray(values) || !values.every(value => typeof value === 'string')) {
			throw new Error('Invalid file resources on the clipboard');
		}
		return values.map(value => URI.parse(value));
	}

	async writeResources(resources: readonly URI[]): Promise<void> {
		if (!this.clipboard) throw new Error('The browser clipboard is unavailable');
		if (resources.length === 0) {
			await this.clipboard.writeText('');
			return;
		}
		await this.clipboard.write([new ClipboardItem({
			[BrowserClipboardService.fileFormat]: new Blob(
				[JSON.stringify(resources.map(resource => resource.toString()))],
				{ type: 'application/x-ash-resources' },
			),
		})]);
	}

	async hasResources(): Promise<boolean> {
		return (await this.readResources()).length > 0;
	}
}
