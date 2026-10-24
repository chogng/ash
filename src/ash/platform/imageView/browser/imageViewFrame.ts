import { addDisposableListener } from '../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { validateImageViewCompletion, validateImageViewPermissionAction, type ImageViewCompletion, type ImageViewPermissionAction } from '../common/imageView.js';

/** Extension HTML runs in an opaque sandbox. Only the finite image-view message contract crosses it. */
export function createImageViewFrame(document: Document, title: string, html: string, input: object, complete: (result: ImageViewCompletion) => Promise<boolean>, ready: () => void, permissionAction?: (action: ImageViewPermissionAction) => Promise<boolean>) {
	const lifetime = new DisposableStore();
	const originalFocus = document.activeElement as HTMLElement | null;
	const container = document.createElement('dialog');
	container.setAttribute('role', 'presentation');
	container.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;';
	const frame = document.createElement('iframe');
	frame.title = title;
	frame.sandbox.add('allow-scripts');
	frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;';
	frame.srcdoc = html;
	let initialized = false;
	let pending = false;
	lifetime.add(addDisposableListener(document.defaultView!, 'message', rawEvent => {
		const event = rawEvent as MessageEvent;
		if (event.source !== frame.contentWindow || !event.data || typeof event.data !== 'object') return;
		if (event.data.type === 'initialize' && !initialized) {
			initialized = true;
			frame.contentWindow!.postMessage({ ...input, type: 'initialize' }, '*');
		} else if (event.data.type === 'ready' && initialized) {
			ready();
		} else if (event.data.type === 'permission' && initialized && !pending) {
			pending = true;
			void (async () => {
				try {
					// Only a host-created consent window receives this capability. Ordinary image
					// editors cannot invoke OS actions by posting a permission message themselves.
					if (!permissionAction) throw new Error('Screen permission actions are unavailable');
					const accepted = await permissionAction(validateImageViewPermissionAction(event.data.action));
					frame.contentWindow?.postMessage({ type: 'permissionResult', accepted }, '*');
				} catch (error) { frame.contentWindow?.postMessage({ type: 'permissionResult', error: String(error) }, '*'); }
				finally { pending = false; }
			})();
		} else if (event.data.type === 'complete' && initialized && !pending) {
			pending = true;
			void (async () => {
				try {
					const accepted = await complete(validateImageViewCompletion(event.data.result));
					frame.contentWindow?.postMessage({ type: 'completed', accepted }, '*');
				} catch (error) { frame.contentWindow?.postMessage({ type: 'completed', error: String(error) }, '*'); }
				finally { pending = false; }
			})();
		}
	}));
	lifetime.add(addDisposableListener(container, 'cancel', event => { event.preventDefault(); void complete({ kind: 'cancel' }); }));
	lifetime.add(toDisposable(() => { container.close(); container.remove(); if (originalFocus?.isConnected) originalFocus.focus(); }));
	container.append(frame);
	document.body.append(container);
	container.showModal();
	return lifetime;
}
