import { toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { invoke, subscribe } from '../../ipc/electron-browser/rendererIpc.js';
import { WINDOW_CLOSE_RESPONSE_CHANNEL, WINDOW_PREPARE_CLOSE_CHANNEL } from '../../window/common/window.js';

/** Registers the renderer's save join before allowing its Electron window to close. */
export async function registerWindowCloseHandler(shutdown: () => Promise<void>): Promise<IDisposable> {
	const requests = subscribe<number>(WINDOW_PREPARE_CLOSE_CHANNEL, token => {
		document.body.inert = true;
		void (async () => {
			try {
				await shutdown();
				await invoke<void>(WINDOW_CLOSE_RESPONSE_CHANNEL, { kind: 'complete', token });
			} catch (error) {
				document.body.inert = false;
				console.error('Failed to save window state before closing', error);
				await invoke<void>(WINDOW_CLOSE_RESPONSE_CHANNEL, {
					kind: 'failed', token,
					message: localize({ bundle: 'ash', key: 'workbench.closeSaveFailed' }, 'The window could not close because its state was not saved.'),
				});
			}
		})().catch(error => console.error('Failed to complete window close request', error));
	});
	try {
		await invoke<void>(WINDOW_CLOSE_RESPONSE_CHANNEL, { kind: 'ready' });
	} catch (error) {
		requests.dispose();
		throw error;
	}
	return toDisposable(() => requests.dispose());
}
