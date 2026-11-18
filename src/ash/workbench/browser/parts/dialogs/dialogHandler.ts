import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Dialog, type IDialogOptions } from '../../../../base/browser/ui/dialog/dialog.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import {
	type DialogRequest,
	DialogResult,
	DialogSeverity,
	getDialogButtons,
	getDialogOutcome,
	type IDialogHandler,
	type IDialogOutcome,
} from '../../../../platform/dialogs/common/dialogs.js';
import { createWorkbenchDialogOptions } from './dialog.js';

interface BrowserDialogPresentation extends Pick<
	IDialogOptions, 'icon' | 'extraClasses' | 'layout' | 'detailElement' | 'buttonOptions' |
	'disableCloseButton' | 'disableDefaultAction' | 'focusCancelButton'
> {
	readonly messageAsTitle?: boolean;
	readonly confirmationLayout?: 'form';
}

/** Presents a workbench dialog in the container owned by its caller. */
export class BrowserDialogHandler implements IDialogHandler {
	constructor(private readonly container: HTMLElement, private readonly presentation?: BrowserDialogPresentation) { }

	async showDialog(request: DialogRequest, signal: AbortSignal): Promise<IDialogOutcome> {
		if (signal.aborted) {
			return { button: DialogResult.Cancel };
		}

		const { buttons, cancelId } = getDialogButtons(request);
		const { messageAsTitle, confirmationLayout, ...presentation } = this.presentation ?? {};
		const formConfirmation = confirmationLayout === 'form' && (request.kind === 'confirmation' || request.kind === 'choice');
		const destructiveForm = formConfirmation && request.kind === 'confirmation' && request.destructive;
		const severity = request.kind === 'message' || request.kind === 'choice' ? request.severity : undefined;
		const showSeverity = severity === DialogSeverity.Warning || severity === DialogSeverity.Error;
		const title = messageAsTitle ? request.message : request.title ?? defaultTitle(request);
		const options = createWorkbenchDialogOptions({
			...presentation,
			...(formConfirmation && {
				layout: 'form',
				focusCancelButton: true,
				extraClasses: [
					...(presentation.extraClasses ?? []),
					destructiveForm ? 'ash-dialog-destructive-confirmation' : 'ash-dialog-form-confirmation',
				],
			}),
			...(destructiveForm && { buttonOptions: [{ presentation: 'danger' }, { presentation: 'secondary' }] }),
			cancelId,
			type: messageAsTitle || (formConfirmation && !showSeverity) ? 'none' : severity ?? 'question',
			detail: request.detail,
			detailPresentation: request.detailPresentation,
			inputs: request.kind === 'input' ? request.inputs.map(input => ({ ...input })) : undefined,
			checkboxLabel: request.checkbox?.label,
			checkboxChecked: request.checkbox?.checked,
			renderBody: messageAsTitle ? undefined : body => {
				body.append(h(body.ownerDocument, 'p', { className: 'ash-dialog-message' }, request.message));
			},
		});

		using resources = new DisposableStore();
		const dialog = resources.add(new Dialog(this.container, title, buttons, options));
		// A custom button renderer can abort while the widget is being constructed.
		if (signal.aborted) {
			return { button: DialogResult.Cancel };
		}
		resources.add(addDisposableListener(signal, 'abort', () => dialog.dispose(), { once: true }));
		const result = await dialog.show();
		if (signal.aborted) {
			return { button: DialogResult.Cancel };
		}
		const outcome = getDialogOutcome(request, result.button, cancelId, result.checkboxChecked);
		return {
			...outcome,
			values: request.kind === 'input' && outcome.button === DialogResult.Primary ? result.values : undefined,
		};
	}
}

function defaultTitle(request: DialogRequest): string {
	if (request.kind === 'input') {
		return localize('dialog.input', 'Input');
	}
	if (request.kind !== 'message') {
		return localize('dialog.confirm', 'Confirm');
	}
	switch (request.severity) {
		case DialogSeverity.Warning:
			return localize('dialog.warning', 'Warning');
		case DialogSeverity.Error:
			return localize('dialog.error', 'Error');
		default:
			return localize('dialog.information', 'Information');
	}
}
