import { invoke } from '../../ipc/electron-browser/rendererIpc.js';
import { NATIVE_HOST_DIALOG_CHANNEL } from '../../native/common/nativeHost.js';
import { DialogResult, type DialogRequest, type IDialogOutcome } from '../common/dialogs.js';

let nextDialogId = 0;

/** Sends a renderer dialog request to its owning Electron window. */
export async function showNativeDialog(request: DialogRequest, signal: AbortSignal): Promise<IDialogOutcome> {
	if (signal.aborted) return { button: DialogResult.Cancel };
	const id = ++nextDialogId;
	const abort = (): void => {
		void invoke<void>(NATIVE_HOST_DIALOG_CHANNEL, { kind: 'cancel', id })
			.catch(error => console.error('Failed to cancel system dialog', error));
	};
	signal.addEventListener('abort', abort, { once: true });
	try {
		const result = await invoke<IDialogOutcome>(NATIVE_HOST_DIALOG_CHANNEL, { kind: 'show', id, request });
		return signal.aborted ? { button: DialogResult.Cancel } : result;
	} finally {
		signal.removeEventListener('abort', abort);
	}
}
