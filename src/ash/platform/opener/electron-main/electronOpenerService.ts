import { shell } from "electron";
import { normalizeExternalUrl, type IExternalOpener } from '../common/opener.js';

/** Electron shell adapter for validated external URLs. */
export class ElectronOpenerService implements IExternalOpener {
	async openExternal(target: string): Promise<boolean> {
		await shell.openExternal(normalizeExternalUrl(target));
		return true;
	}
}
