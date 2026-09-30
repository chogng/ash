import { toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { invoke, subscribe } from '../../../../platform/ipc/electron-browser/rendererIpc.js';
import { BrowserLifecycleService } from '../browser/lifecycleService.js';
import { ShutdownVetoError, type ShutdownReason } from '../common/lifecycle.js';
import { WINDOW_CLOSE_RESPONSE_CHANNEL, WINDOW_PREPARE_CLOSE_CHANNEL, WINDOW_PREPARE_LOAD_CHANNEL } from '../../../../platform/window/common/window.js';

/** Coordinates Electron's close handshake with the renderer's shutdown join point. */
export class ElectronLifecycleService extends BrowserLifecycleService {
	/** The main process may send close requests only after Workbench has registered its shutdown participants. */
	async initialize(): Promise<void> {
		this.assertNotDisposed();
		const handleRequest = (token: number, reason: ShutdownReason): void => {
			document.body.inert = true;
			void (async () => {
				try {
					await this.shutdown(reason);
					await invoke<void>(WINDOW_CLOSE_RESPONSE_CHANNEL, { kind: 'complete', token });
				} catch (error) {
					document.body.inert = false;
					if (error instanceof ShutdownVetoError) {
						await invoke<void>(WINDOW_CLOSE_RESPONSE_CHANNEL, { kind: 'vetoed', token });
						return;
					}
					console.error('Failed to save window state before closing', error);
					await invoke<void>(WINDOW_CLOSE_RESPONSE_CHANNEL, {
						kind: 'failed', token,
						message: localize({ bundle: 'ash', key: 'workbench.closeSaveFailed' }, 'The window could not close because its state was not saved.'),
					});
				}
			})().catch(error => console.error('Failed to complete window close request', error));
		};
		const closeRequests = subscribe<number>(WINDOW_PREPARE_CLOSE_CHANNEL, token => handleRequest(token, 'windowClose'));
		const subscription = this._register(toDisposable(() => closeRequests.dispose()));
		const loadRequests = subscribe<number>(WINDOW_PREPARE_LOAD_CHANNEL, token => handleRequest(token, 'load'));
		this._register(toDisposable(() => loadRequests.dispose()));
		try {
			await invoke<void>(WINDOW_CLOSE_RESPONSE_CHANNEL, { kind: 'ready' });
		} catch (error) {
			subscription.dispose();
			throw error;
		}
	}
}
