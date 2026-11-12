import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { getBrowserViewSessionNetwork } from '../../../../../platform/browserView/common/browserView.js';
import { IBrowserViewWorkbenchService, type IBrowserViewModel } from '../../common/browserView.js';

/** The indicator reads the route actually attached by Main, rather than inferring it from window selection. */
export class BrowserRemoteIndicatorContribution extends Disposable {
	private readonly element: HTMLElement;
	constructor(container: HTMLElement, @IBrowserViewWorkbenchService private readonly browsers: IBrowserViewWorkbenchService) {
		super();
		this.element = container.ownerDocument.createElement('span');
		this.element.className = 'ash-browser-status';
		this.element.setAttribute('role', 'status');
		container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
	}
	public update(model: IBrowserViewModel | undefined): void {
		const authority = model?.info.remoteAuthority;
		let message = '';
		if (authority && model) {
			const network = getBrowserViewSessionNetwork(model.info.session) ?? { authority };
			const { label, connected } = this.browsers.getNetworkStatus(network);
			message = model.state.url.startsWith('file:')
				? localize({ bundle: 'ash.workbench', key: 'browser.remoteFileLocal' }, 'Local file')
				: connected
					? localize({ bundle: 'ash.workbench', key: 'browser.remoteConnected' }, 'Connected via {0}', label)
					: localize({ bundle: 'ash.workbench', key: 'browser.remoteDisconnected' }, '{0} is disconnected. Reload after it reconnects.', label);
		}
		if (this.element.textContent !== message) {
			this.element.textContent = message;
			this.element.title = message;
		}
		this.element.hidden = !message;
	}
}
