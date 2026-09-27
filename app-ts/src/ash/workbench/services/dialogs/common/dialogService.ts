import { Disposable } from "../../../../base/common/lifecycle.js";
import type { Event } from '../../../../base/common/event.js';
import { localize } from "../../../../nls.js";
import {
	type IConfirmationDialogOptions,
	type IConfirmationDialogResult,
	type IActionPromptOptions,
	type IActionPromptResult,
	type IDialogService,
	type IInputDialogOptions,
	type IInputDialogResult,
	type IMessageDialogOptions,
	DialogResult,
	DialogSeverity,
} from "../../../../platform/dialogs/common/dialogs.js";
import { DialogsModel } from "../../../common/dialogs.js";
import packageMetadata from '../../../../../../package.json' with { type: 'json' };

/**
 * Maps the platform dialog API onto the workbench-owned dialog model.
 */
export class DialogService extends Disposable
	implements IDialogService {
	readonly model = this._register(new DialogsModel());
	readonly onWillShowDialog: Event<void> = (listener, thisArgs, disposables) =>
		this.model.onWillShowDialog(() => listener.call(thisArgs, undefined), undefined, disposables);
	readonly onDidShowDialog: Event<void> = (listener, thisArgs, disposables) =>
		this.model.onDidCloseDialog(() => listener.call(thisArgs, undefined), undefined, disposables);

	async showMessage(options: IMessageDialogOptions): Promise<void> {
		const handle = this.model.show({
			kind: "message",
			...options,
			title: options.title ?? messageTitle(options.severity),
			primaryButton: options.primaryButton ?? localize('dialog.ok', 'OK'),
		});
		await handle.result;
	}

	info(message: string, detail?: string): Promise<void> {
		return this.showMessage({ severity: DialogSeverity.Info, message, detail });
	}

	warn(message: string, detail?: string): Promise<void> {
		return this.showMessage({ severity: DialogSeverity.Warning, message, detail });
	}

	error(message: string, detail?: string): Promise<void> {
		return this.showMessage({ severity: DialogSeverity.Error, message, detail });
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

	async prompt<T>(options: IActionPromptOptions<T>): Promise<IActionPromptResult<T>> {
		const result = await this.model.show({
			kind: 'choice',
			message: options.message,
			title: options.title ?? localize('dialog.confirm', 'Confirm'),
			detail: options.detail,
			severity: options.severity,
			checkbox: options.checkbox,
			buttons: options.buttons.map(button => button.label),
			cancelButton: typeof options.cancelButton === 'object'
				? options.cancelButton.label : options.cancelButton ?? localize('dialog.cancel', 'Cancel'),
		}).result;
		const checkbox = { checkboxChecked: result.checkboxChecked };
		const action = result.buttonIndex === undefined
			? typeof options.cancelButton === 'object' ? options.cancelButton : undefined
			: options.buttons[result.buttonIndex];
		return { result: action ? await action.run(checkbox) : undefined, ...checkbox };
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

	about(): Promise<void> {
		return this.showMessage({
			severity: DialogSeverity.Info,
			title: localize('dialog.aboutTitle', 'About Ash'),
			message: 'Ash',
			detail: localize('dialog.aboutVersion', 'Version {0}', packageMetadata.version),
		});
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
