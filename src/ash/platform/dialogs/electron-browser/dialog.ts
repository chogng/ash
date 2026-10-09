import { invoke } from '../../ipc/electron-browser/rendererIpc.js';
import { NATIVE_HOST_DIALOG_CHANNEL, validateMessageBoxResult } from '../../native/common/nativeHost.js';
import type { MessageBoxOptions, MessageBoxReturnValue } from '../../../base/parts/sandbox/common/electronTypes.js';

let nextDialogId = 0;

/** Sends a renderer dialog request to its owning Electron window. */
export async function showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
	const { signal, ...parameters } = options;
	const cancelled = (): MessageBoxReturnValue => ({ response: options.cancelId ?? 0, checkboxChecked: options.checkboxChecked ?? false });
	if (signal?.aborted) return cancelled();
	const id = ++nextDialogId;
	const abort = (): void => {
		void invoke<void>(NATIVE_HOST_DIALOG_CHANNEL, { kind: 'cancel', id })
			.catch(error => console.error('Failed to cancel system dialog', error));
	};
	signal?.addEventListener('abort', abort, { once: true });
	try {
		// AbortSignal belongs to this process; Main owns an independent controller for the request ID.
		const result = validateMessageBoxResult(await invoke<unknown>(NATIVE_HOST_DIALOG_CHANNEL, { kind: 'show', id, options: parameters }));
		return signal?.aborted ? cancelled() : result;
	} finally {
		signal?.removeEventListener('abort', abort);
	}
}
