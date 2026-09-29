import type { IClipboardService } from '../common/clipboardService.js';
import type { URI } from '../../../base/common/uri.js';

/** Browser Clipboard API adapter with explicit availability failure. */
export class BrowserClipboardService implements IClipboardService {
	private resources: readonly URI[] = [];
	constructor(private readonly clipboard: Pick<Clipboard, 'readText' | 'writeText'> | undefined) {}

	async readText(): Promise<string> {
		if (!this.clipboard) throw new Error('The browser clipboard is unavailable');
		return this.clipboard.readText();
	}

	async writeText(value: string): Promise<void> {
		if (!this.clipboard) throw new Error('The browser clipboard is unavailable');
		await this.clipboard.writeText(value);
		this.resources = [];
	}

	async readResources(): Promise<readonly URI[]> {
		return this.resources;
	}

	async writeResources(resources: readonly URI[]): Promise<void> {
		this.resources = [...resources];
	}

	async hasResources(): Promise<boolean> {
		return this.resources.length > 0;
	}
}
