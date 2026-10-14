import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { BrowserViewEvent, IBrowserViewState } from '../../../../../platform/browserView/common/browserView.js';
import { localize } from '../../../../../nls.js';

/** Owns accessible page status, including failed navigation and download progress. */
export class BrowserEditorErrorFeatures extends Disposable {
	constructor(private readonly status: HTMLElement, private readonly downloads: HTMLElement) { super(); }
	public render(state: IBrowserViewState): void {
		this.status.textContent = state.errorDescription
			? localize({ bundle: 'ash.workbench', key: 'browser.loadFailure' }, 'Unable to load page: {0}', state.errorDescription)
			: state.loading ? localize({ bundle: 'ash.workbench', key: 'browser.loading' }, 'Loading page…') : state.title || state.url;
	}
	public accept(event: BrowserViewEvent): void {
		if (event.type === 'loadFailed') { this.status.textContent = localize({ bundle: 'ash.workbench', key: 'browser.loadFailure' }, 'Unable to load page: {0}', event.errorDescription); }
		if (event.type === 'renderProcessGone') { this.status.textContent = localize({ bundle: 'ash.workbench', key: 'browser.processGone' }, 'Page stopped: {0}', event.reason); }
		if (event.type === 'downloadProgress') {
			this.downloads.hidden = false;
			const state = event.state === 'progressing' ? localize({ bundle: 'ash.workbench', key: 'browser.downloading' }, 'downloading')
				: event.state === 'completed' ? localize({ bundle: 'ash.workbench', key: 'browser.downloadCompleted' }, 'completed')
					: event.state === 'cancelled' ? localize({ bundle: 'ash.workbench', key: 'browser.downloadCancelled' }, 'cancelled') : localize({ bundle: 'ash.workbench', key: 'browser.downloadInterrupted' }, 'interrupted');
			this.downloads.textContent = localize({ bundle: 'ash.workbench', key: 'browser.downloadProgress' }, '{0}: {1} / {2} bytes ({3})', event.filename, event.receivedBytes, event.totalBytes, state);
		}
	}
}
