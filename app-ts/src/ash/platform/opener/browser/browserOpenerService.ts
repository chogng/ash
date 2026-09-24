import { normalizeExternalUrl, type IOpenerService } from "../common/openerService.js";

/** Browser popup adapter for validated external URLs. */
export class BrowserOpenerService implements IOpenerService {
	constructor(private readonly ownerWindow: Pick<Window, "open">) {}

	async openExternal(target: string): Promise<void> {
		this.ownerWindow.open(normalizeExternalUrl(target), "_blank", "noopener,noreferrer");
	}
}
