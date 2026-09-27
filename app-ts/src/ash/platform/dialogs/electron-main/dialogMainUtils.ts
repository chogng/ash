import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { DialogResult, type DialogRequest, type IDialogOutcome } from '../common/dialogs.js';

export function messageBoxOptions(request: Exclude<DialogRequest, { kind: 'input' }>, signal: AbortSignal): MessageBoxOptions {
	const buttons = request.kind === 'message'
		? [request.primaryButton ?? 'OK']
		: request.kind === 'confirmation'
			? [request.primaryButton ?? 'Confirm', request.cancelButton ?? 'Cancel']
			: [request.primaryButton, request.secondaryButton, request.cancelButton ?? 'Cancel'];
	return {
		type: request.kind === 'message' ? request.severity : 'question',
		title: request.title,
		message: request.message,
		detail: request.detail,
		buttons,
		checkboxLabel: request.checkbox?.label,
		checkboxChecked: request.checkbox?.checked,
		cancelId: buttons.length - 1,
		defaultId: 0,
		signal,
	};
}

export function messageBoxOutcome(
	request: Exclude<DialogRequest, { kind: 'input' }>,
	result: MessageBoxReturnValue,
): IDialogOutcome {
	if (request.kind !== 'message' && result.response === (request.kind === 'confirmation' ? 1 : 2)) {
		return { button: DialogResult.Cancel, checkboxChecked: result.checkboxChecked };
	}
	return {
		button: result.response === 0 ? DialogResult.Primary : DialogResult.Secondary,
		checkboxChecked: result.checkboxChecked,
	};
}
