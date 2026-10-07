import { addDisposableListener } from '../../base/browser/dom.js';
import { onUnexpectedError } from '../../base/common/errors.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { BrowserClipboardService } from '../../platform/clipboard/browser/clipboardService.js';
import { showStartupError } from '../../workbench/browser/startupError.js';
import { createSessionsProfile, type SessionsProfile } from '../common/sessionsProfile.js';
import { SessionsBrowserMain } from './web.main.js';

/** Creates Sessions in the supplied container; disposal waits for startup before shutdown. */
export function create(domElement: HTMLElement, options: SessionsProfile): IDisposable {
	const ownerWindow = domElement.ownerDocument.defaultView;
	if (!ownerWindow) { throw new Error('Sessions renderer requires an owner window'); }
	const main = new SessionsBrowserMain(domElement, createSessionsProfile(options));
	const lifetime = new DisposableStore();
	const opening = main.open();
	// A close during asynchronous startup still owns the instance that finishes opening.
	lifetime.add(toDisposable(() => {
		void opening.then(async workbench => {
			try {
				await workbench.shutdown('pageHide');
			} finally {
				main.dispose();
			}
		}, () => main.dispose()).catch(onUnexpectedError);
	}));
	lifetime.add(addDisposableListener(ownerWindow, 'pagehide', () => lifetime.dispose(), { once: true }));
	void opening.catch(error => {
		if (lifetime.isDisposed) { return; }
		lifetime.add(showStartupError(error, text => new BrowserClipboardService(ownerWindow.navigator.clipboard).writeText(text)));
	});
	return lifetime;
}
