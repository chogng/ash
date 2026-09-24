import { addDisposableListener, h } from '../../base/browser/dom.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';

/** Keeps connection failures visible before Workbench services are available. */
export function showStartupError(error: unknown): IDisposable {
	console.error('Unable to start Ash', error);
	const container = document.querySelector<HTMLElement>('#app') ?? document.body;
	const message = h(document, 'section');
	message.setAttribute('role', 'alert');
	const title = h(document, 'h1');
	title.textContent = 'Unable to start Ash';
	const detail = h(document, 'p');
	detail.textContent = error instanceof Error ? error.message : String(error);
	const retry = h(document, 'button');
	retry.type = 'button';
	retry.textContent = 'Retry';
	message.append(title, detail, retry);
	container.replaceChildren(message);
	const resources = new DisposableStore();
	resources.add(addDisposableListener(retry, 'click', () => window.location.reload()));
	resources.add(toDisposable(() => message.remove()));
	resources.add(addDisposableListener(window, 'pagehide', () => resources.dispose(), { once: true }));
	retry.focus();
	return resources;
}
