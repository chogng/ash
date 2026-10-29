import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { h } from '../../../../../base/browser/dom.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, type IBrowserEditorWidget } from '../browserEditor.js';
import type { IBrowserViewModel } from '../../common/browserView.js';
import type { BrowserViewEvent, IBrowserViewState } from '../../../../../platform/browserView/common/browserView.js';
import { localize } from '../../../../../nls.js';

/** Owns accessible page status, including failed navigation and download progress. */
export class BrowserEditorErrorFeatures extends BrowserEditorContribution {
	private readonly status: HTMLElement;
	private readonly downloads: HTMLElement;
	constructor(editor: BrowserEditor) {
		super(editor);
		const document = editor.browserContainer.ownerDocument;
		this.status = h(document, 'div');
		this.status.className = 'ash-browser-status';
		this.status.setAttribute('role', 'status');
		this.downloads = h(document, 'div');
		this.downloads.className = 'ash-browser-status';
		this.downloads.hidden = true;
		this.downloads.setAttribute('role', 'status');
		this.downloads.setAttribute('aria-label', localize({ bundle: 'ash.workbench', key: 'browser.downloads' }, 'Downloads'));
		this._register(editor.onDidChangeStatus(message => { this.status.textContent = message; }));
	}
	override get widgets(): readonly IBrowserEditorWidget[] {
		return [
			{ location: BrowserWidgetLocation.Toolbar, element: this.status, order: 1 },
			{ location: BrowserWidgetLocation.Toolbar, element: this.downloads, order: 2 },
		];
	}
	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		this.render(model.state);
		store.add(model.onDidChangeState(state => this.render(state)));
		store.add(model.onDidEvent(event => this.accept(event)));
	}
	override onModelDetached(): void {
		this.status.textContent = '';
		this.downloads.hidden = true;
	}
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
