import {
	DialogResult,
	getDialogButtons,
	getDialogOutcome,
	type DialogRequest,
	type IDialogHandler,
	type IDialogOutcome,
} from '../../../../platform/dialogs/common/dialogs.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { BrowserDialogHandler } from '../../../browser/parts/dialogs/dialogHandler.js';

/** Presents the workbench's queued dialogs in their owning Electron window. */
export class NativeDialogHandler implements IDialogHandler {
	private readonly browser: BrowserDialogHandler;

	constructor(private readonly host: INativeHostApi, container: HTMLElement) {
		this.browser = new BrowserDialogHandler(container);
	}

	async showDialog(request: DialogRequest, signal: AbortSignal): Promise<IDialogOutcome> {
		if (signal.aborted) {
			return { button: DialogResult.Cancel };
		}
		if (request.kind === 'input' || request.custom) {
			return this.browser.showDialog(request, signal);
		}
		const { buttons, cancelId } = getDialogButtons(request);
		const result = await this.host.showMessageBox({
			type: request.kind === 'message' || request.kind === 'choice' ? request.severity ?? 'question' : 'question',
			title: request.title,
			message: request.message,
			detail: request.detail,
			buttons,
			checkboxLabel: request.checkbox?.label,
			checkboxChecked: request.checkbox?.checked,
			// Native message boxes dismiss through their sole button.
			cancelId: Math.max(0, cancelId),
			defaultId: 0,
			signal,
		});
		if (signal.aborted) {
			return { button: DialogResult.Cancel };
		}
		return getDialogOutcome(request, result.response, cancelId, result.checkboxChecked);
	}
}
