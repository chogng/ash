import { defaultButtonStyles, defaultCheckboxStyles, defaultDialogStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { Dialog, type IDialogOptions } from '../../../../base/browser/ui/dialog/dialog.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { type DialogRequest, DialogResult, DialogSeverity, type IDialogHandler, type IDialogOutcome } from '../../../../platform/dialogs/common/dialogs.js';

interface WorkbenchDialogOptions extends Partial<IDialogOptions> {
	readonly shouldConfirmDiscard?: () => boolean;
}

export function createWorkbenchDialogOptions({ shouldConfirmDiscard, ...options }: WorkbenchDialogOptions): IDialogOptions {
	return {
		buttonStyles: defaultButtonStyles,
		checkboxStyles: defaultCheckboxStyles,
		inputBoxStyles: defaultInputBoxStyles,
		dialogStyles: defaultDialogStyles,
		...options,
		...(shouldConfirmDiscard && {
			confirmClose: {
				shouldConfirm: shouldConfirmDiscard,
				message: localize('dialog.discardChangesTitle', 'Discard unsaved changes?'),
				detail: localize('dialog.discardChangesDetail', 'Your changes haven’t been saved and will be lost.'),
				confirmButton: localize('dialog.discardChangesButton', 'Discard'),
				cancelButton: localize('dialog.keepEditingButton', 'Keep editing'),
				confirmPresentation: 'danger',
			},
		}),
	};
}

export interface BrowserDialogPresentation extends Pick<IDialogOptions, 'icon' | 'extraClasses' | 'detailElement' | 'buttonOptions' | 'disableCloseButton' | 'disableDefaultAction' | 'focusCancelButton'> {
	readonly messageAsTitle?: boolean;
}

/** Maps queued domain requests to the service-independent Dialog widget. */
export class BrowserDialogHandler implements IDialogHandler {
	constructor(private readonly container: HTMLElement, private readonly presentation?: BrowserDialogPresentation) { }

	async showDialog(request: DialogRequest, signal: AbortSignal): Promise<IDialogOutcome> {
		if (signal.aborted) return { button: DialogResult.Cancel };
		const disposables = new DisposableStore();
		try {
			const buttons = request.kind === 'choice'
				? [...request.buttons]
				: [request.primaryButton ?? (request.kind === 'confirmation' ? localize('dialog.confirm', 'Confirm') : localize('dialog.ok', 'OK'))];
			if (request.kind === 'prompt') buttons.push(request.secondaryButton);
			if (request.kind !== 'message') buttons.push(request.cancelButton ?? localize('dialog.cancel', 'Cancel'));
			const cancelId = request.kind === 'message' ? -1 : buttons.length - 1;
			const title = this.presentation?.messageAsTitle ? request.message : request.title ?? defaultTitle(request);
			const options = createWorkbenchDialogOptions({
				...this.presentation,
				cancelId,
				type: this.presentation?.messageAsTitle ? 'none' : request.kind === 'message' || request.kind === 'choice' ? request.severity ?? 'question' : 'question',
				detail: request.detail,
				inputs: request.kind === 'input' ? request.inputs.map(input => ({ ...input })) : undefined,
				checkboxLabel: request.checkbox?.label,
				checkboxChecked: request.checkbox?.checked,
				renderBody: this.presentation?.messageAsTitle ? undefined : body => {
					const message = h(body.ownerDocument, 'p', { className: 'ash-dialog-message' });
					message.textContent = request.message;
					body.append(message);
				},
			});
			const dialog = disposables.add(new Dialog(this.container, title, buttons, options));
			disposables.add(addDisposableListener(signal, 'abort', () => dialog.dispose(), { once: true }));
			const result = await dialog.show();
			const cancelled = result.button === cancelId;
			const button = cancelled ? DialogResult.Cancel : request.kind === 'choice' || result.button === 0 ? DialogResult.Primary : DialogResult.Secondary;
			return {
				button,
				...(request.kind === 'choice' && !cancelled ? { buttonIndex: result.button } : {}),
				checkboxChecked: result.checkboxChecked,
				values: button === DialogResult.Primary && request.kind === 'input' ? result.values : undefined,
			};
		} finally {
			disposables.dispose();
		}
	}
}

function defaultTitle(request: DialogRequest): string {
	if (request.kind === 'input') return localize('dialog.input', 'Input');
	if (request.kind !== 'message') return localize('dialog.confirm', 'Confirm');
	switch (request.severity) {
		case DialogSeverity.Warning:
			return localize('dialog.warning', 'Warning');
		case DialogSeverity.Error:
			return localize('dialog.error', 'Error');
		default:
			return localize('dialog.information', 'Information');
	}
}
