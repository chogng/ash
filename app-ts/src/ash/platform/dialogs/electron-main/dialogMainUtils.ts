import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron';
import { release } from 'node:os';
import { DialogResult, type DialogRequest, type IDialogOutcome } from '../common/dialogs.js';

export function massageMessageBoxOptions(
	options: MessageBoxOptions,
	platform: NodeJS.Platform = process.platform,
): { options: MessageBoxOptions; buttonIndices: readonly number[] } {
	const buttons = [...options.buttons ?? []];
	const buttonIndices = buttons.map((_, index) => index);
	const originalDefault = options.defaultId ?? 0;
	const originalCancel = options.cancelId ?? buttons.length - 1;
	const legacyMacOrder = platform === 'darwin' && Number.parseInt(release(), 10) < 24;
	if (buttons.length > 1 && (platform === 'linux' || legacyMacOrder) && originalCancel !== 1) {
		buttons.splice(1, 0, buttons.splice(originalCancel, 1)[0]!);
		buttonIndices.splice(1, 0, buttonIndices.splice(originalCancel, 1)[0]!);
	}
	if (platform === 'linux') {
		buttons.reverse();
		buttonIndices.reverse();
	}
	return {
		options: {
			...options,
			...(buttons.length ? {
				buttons,
				defaultId: buttonIndices.indexOf(originalDefault),
				cancelId: buttonIndices.indexOf(originalCancel),
			} : {}),
			noLink: true,
		},
		buttonIndices,
	};
}

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
