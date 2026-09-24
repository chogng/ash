import { shell } from "electron";
import { normalizeExternalUrl, type IOpenerService } from "../common/openerService.js";

/** Electron shell adapter for validated external URLs. */
export class ElectronOpenerService implements IOpenerService {
	openExternal(target: string): Promise<void> {
		return shell.openExternal(normalizeExternalUrl(target));
	}
}
