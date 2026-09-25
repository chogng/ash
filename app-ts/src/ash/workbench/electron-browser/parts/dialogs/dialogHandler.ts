import { DialogResult, type DialogRequest, type IDialogHandler, type IDialogOutcome } from '../../../../platform/dialogs/common/dialogs.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { BrowserDialogHandler } from '../../../browser/parts/dialogs/dialogHandler.js';

/** Presents the workbench's queued dialogs in their owning Electron window. */
export class NativeDialogHandler implements IDialogHandler {
	private readonly browser: BrowserDialogHandler;

	constructor(private readonly host: INativeHostApi, container: HTMLElement) {
		this.browser = new BrowserDialogHandler(container);
	}

	showDialog(request: DialogRequest, signal: AbortSignal): Promise<IDialogOutcome> {
		if (signal.aborted) return Promise.resolve({ button: DialogResult.Cancel });
		if (request.kind === 'input') return this.browser.showDialog(request, signal);
		return this.host.showNativeDialog(request, signal);
	}
}
