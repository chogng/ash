import { addDisposableListener, getWindow } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
import { validatePngImage } from '../../../../platform/imageResize/common/imageData.js';
import type { IWebviewService } from '../../../contrib/webview/browser/webview.js';
import type { ImageEditorCompletion } from '../common/imageEditorService.js';
import { localize } from '../../../../nls.js';

/** The existing Webview host owns origin isolation and document-scoped message channels. */
export function createImageEditorWebview(document: Document, webviews: IWebviewService, title: string, html: string, input: object, complete: (result: ImageEditorCompletion) => Promise<boolean>): IDisposable {
	const lifetime = new DisposableStore();
	const originalFocus = document.activeElement as HTMLElement | null;
	const container = document.createElement('dialog');
	container.setAttribute('role', 'presentation');
	container.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;';
	const view = lifetime.add(webviews.createWebviewElement({ title, options: {}, contentOptions: { allowScripts: true, messageProtocol: 'imageEditor', localResourceRoots: [] } }));
	const timeout = setTimeout(() => { void complete({ kind: 'error', message: localize('imageEditor.readyTimeout', 'Image editor did not become ready') }); }, 15000);
	lifetime.add(toDisposable(() => clearTimeout(timeout)));
	let initialized = false;
	let pending = false;
	lifetime.add(view.onMessage(({ message }) => {
		if (!isRecord(message)) { return; }
		if (message.type === 'initialize' && !initialized) {
			initialized = true;
			void view.postMessage({ ...input, type: 'initialize' });
		} else if (message.type === 'ready' && initialized) {
			clearTimeout(timeout);
		} else if (message.type === 'complete' && initialized && !pending) {
			pending = true;
			void (async () => {
				try { await view.postMessage({ type: 'completed', accepted: await complete(validateImageEditorCompletion(message.result)) }); }
				catch (error) { await view.postMessage({ type: 'completed', error: String(error) }); }
				finally { pending = false; }
			})();
		}
	}));
	lifetime.add(addDisposableListener(container, 'cancel', event => { event.preventDefault(); void complete({ kind: 'cancel' }); }));
	lifetime.add(toDisposable(() => { container.close(); container.remove(); if (originalFocus?.isConnected) { originalFocus.focus(); } }));
	document.body.append(container);
	view.mountTo(container, getWindow(container));
	view.element.style.cssText = 'display:block;width:100%;height:100%;border:0;';
	view.setHtml(html);
	container.showModal();
	return lifetime;
}

function validateImageEditorCompletion(value: unknown): ImageEditorCompletion {
	if (!isRecord(value)) { throw new TypeError('Invalid image editor completion'); }
	if ((value.kind === 'cancel' || value.kind === 'retake') && Object.keys(value).length === 1) { return value as ImageEditorCompletion; }
	if (value.kind === 'error' && Object.keys(value).sort().join(',') === 'kind,message' && typeof value.message === 'string' && value.message.length > 0 && value.message.length <= 4096) { return value as unknown as ImageEditorCompletion; }
	if (!['attach', 'copy', 'save'].includes(value.kind as string) || Object.keys(value).sort().join(',') !== 'image,kind') { throw new TypeError('Invalid image editor completion'); }
	validatePngImage(value.image);
	return value as unknown as ImageEditorCompletion;
}
