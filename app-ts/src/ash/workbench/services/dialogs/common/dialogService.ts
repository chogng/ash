import { Disposable } from "../../../../base/common/lifecycle.js";
import { localize } from "../../../../nls.js";
import {
	type IConfirmationDialogOptions,
	type IConfirmationDialogResult,
	type IDialogService,
	type IInputDialogOptions,
	type IInputDialogResult,
	type IMessageDialogOptions,
	type IPromptDialogOptions,
	DialogResult,
	DialogSeverity,
} from "../../../../platform/dialogs/common/dialogs.js";
import { DialogsModel } from "../../../common/dialogs.js";

/**
 * Maps the platform dialog API onto the workbench-owned dialog model.
 */
export class DialogService extends Disposable
	implements IDialogService {
	readonly model = this._register(new DialogsModel());

	async showMessage(options: IMessageDialogOptions): Promise<void> {
		const handle = this.model.show({
			kind: "message",
			...options,
			title: options.title ?? messageTitle(options.severity),
			primaryButton: options.primaryButton ?? localize('dialog.ok', 'OK'),
		});
		await handle.result;
	}

	async confirm(options: IConfirmationDialogOptions): Promise<IConfirmationDialogResult> {
		const handle = this.model.show({
			kind: "confirmation",
			...options,
			title: options.title ?? localize('dialog.confirm', 'Confirm'),
			primaryButton: options.primaryButton ?? localize('dialog.confirm', 'Confirm'),
			cancelButton: options.cancelButton ?? localize('dialog.cancel', 'Cancel'),
		});
		const result = await handle.result;
		return { confirmed: result.button === DialogResult.Primary, checkboxChecked: result.checkboxChecked };
	}

	prompt(options: IPromptDialogOptions): Promise<DialogResult> {
		return this.model.show({
			kind: "prompt",
			...options,
			title: options.title ?? localize('dialog.confirm', 'Confirm'),
			cancelButton: options.cancelButton ?? localize('dialog.cancel', 'Cancel'),
		}).result.then(result => result.button);
	}

	async input(options: IInputDialogOptions): Promise<IInputDialogResult> {
		const result = await this.model.show({
			kind: "input",
			...options,
			title: options.title ?? localize('dialog.input', 'Input'),
			primaryButton: options.primaryButton ?? localize('dialog.ok', 'OK'),
			cancelButton: options.cancelButton ?? localize('dialog.cancel', 'Cancel'),
		}).result;
		return {
			confirmed: result.button === DialogResult.Primary,
			values: result.values,
			checkboxChecked: result.checkboxChecked,
		};
	}
}

function messageTitle(severity: DialogSeverity): string {
	switch (severity) {
		case DialogSeverity.Warning:
			return localize('dialog.warning', 'Warning');
		case DialogSeverity.Error:
			return localize('dialog.error', 'Error');
		default:
			return localize('dialog.information', 'Information');
	}
}
