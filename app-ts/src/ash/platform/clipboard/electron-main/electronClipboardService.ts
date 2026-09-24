import { clipboard } from "electron";
import type { IClipboardService } from '../common/clipboardService.js';

/** Electron main-process adapter for the system clipboard. */
export class ElectronClipboardService implements IClipboardService {
	async readText(): Promise<string> {
		return clipboard.readText();
	}

	async writeText(value: string): Promise<void> {
		clipboard.writeText(value);
	}
}
