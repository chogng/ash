import '../../../src/ash/base/browser/ui/button/button.css';
import '../../../src/ash/base/browser/ui/dialog/dialog.css';
import '../../../src/ash/base/browser/ui/inputbox/inputbox.css';
import '../../../src/ash/base/browser/ui/toggle/toggle.css';
import { Dialog } from '../../../src/ash/base/browser/ui/dialog/dialog.js';
import { BrowserDialogHandler } from '../../../src/ash/workbench/browser/parts/dialogs/dialogHandler.js';
import type { IDialogOutcome } from '../../../src/ash/platform/dialogs/common/dialogs.js';

declare global {
	interface Window {
		ashDialogIntegration: {
			show(detail: string): void;
			showPrompt(): void;
			showInput(): void;
			showCheckboxConfirmation(): void;
			showBare(): void;
			disposeBare(): void;
			abort(): void;
			lastResult?: string;
			lastOutcome?: IDialogOutcome;
		};
	}
}

const handler = new BrowserDialogHandler(document.body);
let controller: AbortController;
let bareDialog: Dialog;
window.ashDialogIntegration = {
	show(detail: string): void {
		controller = new AbortController();
		void handler.showDialog({
			kind: 'confirmation',
			title: 'Review changes',
			message: 'Review the details before confirming.',
			detail,
		}, controller.signal).then(result => { window.ashDialogIntegration.lastResult = result.button; });
	},
	showPrompt(): void {
		controller = new AbortController();
		void handler.showDialog({
			kind: 'prompt',
			title: 'Save changes',
			message: 'Choose what to do with the changes.',
			primaryButton: 'Save',
			secondaryButton: 'Discard',
		}, controller.signal).then(result => { window.ashDialogIntegration.lastResult = result.button; });
	},
	showInput(): void {
		controller = new AbortController();
		void handler.showDialog({
			kind: 'input',
			title: 'Connect',
			message: 'Enter server address',
			inputs: [{ placeholder: 'Server address', value: 'https://' }],
			checkbox: { label: 'Remember server', checked: false },
		}, controller.signal).then(result => { window.ashDialogIntegration.lastOutcome = result; });
	},
	showCheckboxConfirmation(): void {
		controller = new AbortController();
		void handler.showDialog({
			kind: 'confirmation',
			title: 'Remove server',
			message: 'Remove this server?',
			checkbox: { label: 'Also remove credentials' },
		}, controller.signal).then(result => { window.ashDialogIntegration.lastOutcome = result; });
	},
	showBare(): void {
		bareDialog = new Dialog(document.body, { title: 'Plain dialog', content: 'Plain content' });
		void bareDialog.show().then(result => { window.ashDialogIntegration.lastResult = result; });
	},
	disposeBare(): void {
		bareDialog.dispose();
	},
	abort(): void {
		controller.abort();
	},
};
