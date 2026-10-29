import { DialogResult, type DialogRequest, type IDialogHandler, type IDialogOutcome } from '../../../../platform/dialogs/common/dialogs.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { BrowserDialogHandler } from '../../../browser/parts/dialogs/dialog.js';
import { localize } from '../../../../nls.js';

/** Presents the workbench's queued dialogs in their owning Electron window. */
export class NativeDialogHandler implements IDialogHandler {
	private readonly browser: BrowserDialogHandler;

	constructor(private readonly host: INativeHostApi, container: HTMLElement) {
		this.browser = new BrowserDialogHandler(container);
	}

	async showDialog(request: DialogRequest, signal: AbortSignal): Promise<IDialogOutcome> {
		if (signal.aborted) return { button: DialogResult.Cancel };
		if (request.kind === 'input') return this.browser.showDialog(request, signal);
		let buttons: string[];
		switch (request.kind) {
			case 'choice':
				buttons = [...request.buttons, request.cancelButton];
				break;
			case 'message':
				buttons = [request.primaryButton ?? localize('dialog.ok', 'OK')];
				break;
			case 'confirmation':
				buttons = [request.primaryButton ?? localize('dialog.confirm', 'Confirm'), request.cancelButton ?? localize('dialog.cancel', 'Cancel')];
				break;
			case 'prompt':
				buttons = [request.primaryButton, request.secondaryButton, request.cancelButton ?? localize('dialog.cancel', 'Cancel')];
				break;
		}
		const result = await this.host.showMessageBox({
			type: request.kind === 'message' || request.kind === 'choice' ? request.severity ?? 'question' : 'question',
			title: request.title,
			message: request.message,
			detail: request.detail,
			buttons,
			checkboxLabel: request.checkbox?.label,
			checkboxChecked: request.checkbox?.checked,
			cancelId: buttons.length - 1,
			defaultId: 0,
			signal,
		});
		if (signal.aborted) return { button: DialogResult.Cancel };
		if (request.kind === 'choice') {
			return result.response === request.buttons.length
				? { button: DialogResult.Cancel, checkboxChecked: result.checkboxChecked }
				: { button: DialogResult.Primary, buttonIndex: result.response, checkboxChecked: result.checkboxChecked };
		}
		if (request.kind !== 'message' && result.response === buttons.length - 1) return { button: DialogResult.Cancel, checkboxChecked: result.checkboxChecked };
		return { button: result.response === 0 ? DialogResult.Primary : DialogResult.Secondary, checkboxChecked: result.checkboxChecked };
	}
}
