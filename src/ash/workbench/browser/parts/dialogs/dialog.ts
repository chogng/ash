import { defaultButtonStyles, defaultCheckboxStyles, defaultDialogStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { Dialog } from "../../../../base/browser/ui/dialog/dialog.js";
import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { localize } from "../../../../nls.js";
import { type DialogRequest, DialogResult, DialogSeverity, type IDialogHandler, type IDialogOutcome } from "../../../../platform/dialogs/common/dialogs.js";

/** Maps queued domain requests to the service-independent Dialog widget. */
export class BrowserDialogHandler implements IDialogHandler {
	constructor(private readonly container: HTMLElement) { }

	async showDialog(request: DialogRequest, signal: AbortSignal): Promise<IDialogOutcome> {
		if (signal.aborted) return { button: DialogResult.Cancel };
		const disposables = new DisposableStore();
		try {
			const buttons = request.kind === 'choice'
				? [...request.buttons]
				: [request.primaryButton ?? (request.kind === "confirmation" ? localize('dialog.confirm', 'Confirm') : localize('dialog.ok', 'OK'))];
			if (request.kind === "prompt") buttons.push(request.secondaryButton);
			if (request.kind !== "message") buttons.push(request.cancelButton ?? localize('dialog.cancel', 'Cancel'));
			const cancelId = request.kind === "message" ? -1 : buttons.length - 1;
			const dialog = disposables.add(new Dialog(this.container, request.title ?? defaultTitle(request), buttons, {
				buttonStyles: defaultButtonStyles,
				checkboxStyles: defaultCheckboxStyles,
				inputBoxStyles: defaultInputBoxStyles,
				dialogStyles: defaultDialogStyles,
				cancelId,
				type: request.kind === 'message' || request.kind === 'choice' ? request.severity ?? 'question' : 'question',
				detail: request.detail,
				inputs: request.kind === "input" ? request.inputs.map(input => ({ ...input })) : undefined,
				checkboxLabel: request.checkbox?.label,
				checkboxChecked: request.checkbox?.checked,
				renderBody: body => {
					const message = h(body.ownerDocument, "p", { className: "ash-dialog-message" });
					message.textContent = request.message;
					body.append(message);
				},
			}));
			disposables.add(addDisposableListener(signal, "abort", () => dialog.dispose(), { once: true }));
			const result = await dialog.show();
			const cancelled = result.button === cancelId;
			const button = cancelled ? DialogResult.Cancel : request.kind === 'choice' || result.button === 0 ? DialogResult.Primary : DialogResult.Secondary;
			return {
				button,
				...(request.kind === 'choice' && !cancelled ? { buttonIndex: result.button } : {}),
				checkboxChecked: result.checkboxChecked,
				values: button === DialogResult.Primary && request.kind === "input" ? result.values : undefined,
			};
		} finally {
			disposables.dispose();
		}
	}
}

function defaultTitle(request: DialogRequest): string {
	if (request.kind === "input") return localize('dialog.input', 'Input');
	if (request.kind !== "message") return localize('dialog.confirm', 'Confirm');
	switch (request.severity) {
		case DialogSeverity.Warning:
			return localize('dialog.warning', 'Warning');
		case DialogSeverity.Error:
			return localize('dialog.error', 'Error');
		default:
			return localize('dialog.information', 'Information');
	}
}
