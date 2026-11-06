import { h } from '../../base/browser/dom.js';
import { toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { getNLSLanguage, localize } from '../../nls.js';
import { readBrowserPartsSplash, removePartsSplash } from '../contrib/splash/browser/splash.js';
import { isDarkColorScheme } from '../../platform/theme/common/theme.js';

/** Shows a fallback for browser hosts before Workbench services can report startup failures. */
export function showStartupError(container: HTMLElement, error: unknown): IDisposable {
	console.error('Unable to start Ash', error);
	const { ownerDocument } = container;
	removePartsSplash(ownerDocument);
	const message = h(ownerDocument, 'section');
	message.lang = getNLSLanguage();
	message.setAttribute('role', 'alert');
	// Workbench may have disposed its theme binding before handing startup to this view.
	const colors = readBrowserPartsSplash(ownerDocument.defaultView!);
	Object.assign(message.style, {
		minHeight: '100vh',
		backgroundColor: colors.colorInfo.background,
		color: colors.colorInfo.foreground,
		colorScheme: isDarkColorScheme(colors.baseTheme) ? 'dark' : 'light',
	});
	const title = h(ownerDocument, 'h1');
	title.textContent = localize('workbench.startupError.title', 'Unable to start Ash');
	const description = h(ownerDocument, 'p');
	description.textContent = localize('workbench.startupError.description', 'Check the browser developer tools console for details.');
	message.append(title, description);
	container.replaceChildren(message);
	return toDisposable(() => message.remove());
}
