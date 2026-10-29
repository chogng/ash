import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { IBrowserViewState } from '../../../../../platform/browserView/common/browserView.js';
import { createBrowserWelcome } from '../../browser/browserWelcome.js';

export class BrowserWelcomeFeature extends Disposable {
	private readonly element: HTMLElement;
	constructor(container: HTMLElement) {
		super();
		this.element = createBrowserWelcome(
			localize({ bundle: 'ash.workbench', key: 'browser.title' }, 'Browser'),
			localize({ bundle: 'ash.workbench', key: 'browser.welcome' }, 'Enter a website address above. Choose a search engine in Settings to search from the address bar.'),
			container.ownerDocument,
		);
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
	}
	public update(state: IBrowserViewState | undefined): void {
		this.element.hidden = !state || state.url !== 'about:blank' || state.loading;
	}
}
