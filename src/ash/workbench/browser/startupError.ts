import { addDisposableListener, h } from '../../base/browser/dom.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { localize } from '../../nls.js';
import { readBrowserPartsSplash, removePartsSplash } from '../contrib/splash/browser/splash.js';
import { isDarkColorScheme } from '../../platform/theme/common/theme.js';

/**
 * Shows startup failures before Workbench services can report them.
 * Browser, desktop, and Sessions renderers share this DOM-only view and provide their own clipboard action.
 */
export function showStartupError(error: unknown, writeClipboard: (text: string) => Promise<void>): IDisposable {
	removePartsSplash(document);
	console.error('Unable to start Ash', error);
	const container = document.querySelector<HTMLElement>('#app') ?? document.body;
	const message = h(document, 'section');
	// Workbench may have disposed its theme binding before handing startup to this view.
	const colors = readBrowserPartsSplash(window);
	Object.assign(message.style, {
		minHeight: '100vh',
		backgroundColor: colors.colorInfo.background,
		color: colors.colorInfo.foreground,
		colorScheme: isDarkColorScheme(colors.baseTheme) ? 'dark' : 'light',
	});
	const title = h(document, 'h1');
	title.setAttribute('role', 'alert');
	title.textContent = localize('workbench.startupError.title', 'Unable to start Ash');
	const details = error instanceof Error ? error.message : String(error);
	const detail = h(document, 'textarea');
	detail.readOnly = true;
	detail.rows = 12;
	detail.cols = 80;
	detail.value = details;
	detail.setAttribute('aria-label', localize('workbench.startupError.details', 'Error details'));
	const copy = h(document, 'button');
	copy.type = 'button';
	copy.textContent = localize('workbench.startupError.copy', 'Copy details');
	const retry = h(document, 'button');
	retry.type = 'button';
	retry.textContent = localize('workbench.startupError.retry', 'Retry');
	const copyStatus = h(document, 'p');
	copyStatus.setAttribute('role', 'status');
	message.append(title, detail, copy, retry, copyStatus);
	container.replaceChildren(message);
	const resources = new DisposableStore();
	resources.add(
		addDisposableListener(copy, 'click', () => {
			void writeClipboard(details).then(
				() => {
					copyStatus.textContent = localize('workbench.startupError.copied', 'Error details copied.');
				},
				() => {
					copyStatus.textContent = localize(
						'workbench.startupError.copyFailed',
						'Could not copy. Select the details above to copy them manually.',
					);
				},
			);
		}),
	);
	resources.add(addDisposableListener(retry, 'click', () => window.location.reload()));
	resources.add(toDisposable(() => message.remove()));
	resources.add(addDisposableListener(window, 'pagehide', () => resources.dispose(), { once: true }));
	retry.focus();
	return resources;
}
