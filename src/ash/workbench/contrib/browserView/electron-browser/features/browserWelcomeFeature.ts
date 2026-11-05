import { Button } from '../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { IBrowserViewState } from '../../../../../platform/browserView/common/browserView.js';
import { createBrowserWelcome } from '../../browser/browserWelcome.js';

export class BrowserWelcomeFeature extends Disposable {
	private readonly element: HTMLElement;
	private readonly actions: HTMLElement;
	constructor(container: HTMLElement, focusAddress: () => void) {
		super();
		this.element = createBrowserWelcome(localize({ bundle: 'ash.workbench', key: 'browser.title' }, 'Browser'),
			localize({ bundle: 'ash.workbench', key: 'browser.welcome' }, 'Enter a website address above. Choose a search engine in Settings to search from the address bar.'), container.ownerDocument);
		this.element.hidden = true;
		this.actions = container.ownerDocument.createElement('div');
		this.actions.className = 'ash-browser-welcome-actions';
		this.element.append(this.actions);
		const openAddress = this._register(new Button(this.actions, {
			...defaultButtonStyles,
			presentation: 'secondary',
			label: localize({ bundle: 'ash.workbench', key: 'browser.openAddress' }, 'Open Address…'),
		}));
		this._register(openAddress.onDidClick(focusAddress));
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
	}
	public appendActions(actions: readonly HTMLElement[]): void {
		this.actions.append(...actions);
	}
	public update(state: IBrowserViewState | undefined): void {
		this.element.hidden = !state || state.url !== 'about:blank' || state.loading;
	}
}
