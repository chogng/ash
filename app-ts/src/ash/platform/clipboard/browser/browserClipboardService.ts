import type { IClipboardService } from '../common/clipboardService.js';

/** Browser Clipboard API adapter with explicit availability failure. */
export class BrowserClipboardService implements IClipboardService {
	constructor(private readonly clipboard: Pick<Clipboard, 'readText' | 'writeText'> | undefined) {}

	async readText(): Promise<string> {
		if (!this.clipboard) throw new Error('The browser clipboard is unavailable');
		return this.clipboard.readText();
	}

	async writeText(value: string): Promise<void> {
		if (!this.clipboard) throw new Error('The browser clipboard is unavailable');
		await this.clipboard.writeText(value);
	}
}
