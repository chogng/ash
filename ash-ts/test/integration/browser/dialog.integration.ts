import '../../../src/ash/base/browser/ui/button/button.css';
import '../../../src/ash/base/browser/ui/dialog/dialog.css';
import { BrowserDialogHandler } from '../../../src/ash/platform/dialogs/browser/browserDialogHandler.js';

declare global {
	interface Window {
		ashDialogIntegration: {
			show(detail: string): void;
		};
	}
}

const handler = new BrowserDialogHandler(document.body);
window.ashDialogIntegration = {
	show(detail: string): void {
		void handler.showDialog({
			kind: 'confirmation',
			title: 'Review changes',
			message: 'Review the details before confirming.',
			detail,
		}, new AbortController().signal);
	},
};
