import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { IBrowserViewModel } from '../../common/browserView.js';

/** The indicator reads the route actually attached by Main, rather than inferring it from window selection. */
export class BrowserRemoteIndicatorContribution extends Disposable {
	private readonly element: HTMLElement;
	constructor(container: HTMLElement) {
		super();
		this.element = container.ownerDocument.createElement('span');
		this.element.className = 'ash-browser-status';
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
	}
	public update(model: IBrowserViewModel | undefined): void {
		const authority = model?.info.remoteAuthority;
		this.element.hidden = !authority;
		this.element.textContent = authority
			? localize({ bundle: 'ash.workbench', key: 'browser.remoteRoute' }, 'Remote connection')
			: '';
	}
}
