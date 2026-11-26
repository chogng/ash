import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IBrowserViewService } from '../../../../../platform/browserView/common/browserView.js';
import { h } from '../../../../../base/browser/dom.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, type IBrowserEditorWidget } from '../browserEditor.js';
import type { IBrowserViewModel } from '../../common/browserView.js';
import type { BrowserViewEvent, IBrowserViewState } from '../../../../../platform/browserView/common/browserView.js';
import { localize } from '../../../../../nls.js';

/** Owns accessible page status, including failed navigation, download progress and user control. */
export class BrowserEditorErrorFeatures extends BrowserEditorContribution {
	private readonly status: HTMLElement;
	private readonly downloads: HTMLElement;
	private readonly userControl: HTMLElement;
	constructor(editor: BrowserEditor, @IBrowserViewService private readonly pages: IBrowserViewService) {
		super(editor);
		const document = editor.browserContainer.ownerDocument;
		this.status = h(document, 'div');
		this.status.className = 'ash-browser-status announcement-only';
		this.status.setAttribute('role', 'status');
		this.downloads = h(document, 'div');
		this.downloads.className = 'ash-browser-status';
		this.downloads.hidden = true;
		this.downloads.setAttribute('role', 'status');
		this.downloads.setAttribute('aria-label', localize({ bundle: 'ash.workbench', key: 'browser.downloads' }, 'Downloads'));
		this.userControl = h(document, 'div');
		this.userControl.className = 'ash-browser-navigation';
		this.userControl.hidden = true;
		for (const [label, continued] of [
			[localize({ bundle: 'ash.workbench', key: 'browser.userControl.resume' }, 'Continue with Agent'), true],
			[localize({ bundle: 'ash.workbench', key: 'browser.userControl.cancel' }, 'Cancel handoff'), false],
		] as const) {
			const button = this._register(new Button(this.userControl, { ...defaultButtonStyles, presentation: 'secondary', label }));
			this._register(button.onDidClick(() => {
				const model = editor.model;
				const requestId = model?.state.userControlRequestId;
				if (model && requestId) {
					void this.pages.respondToUserControl(model.id, requestId, continued).catch(error => editor.report(error));
					editor.ensureBrowserFocus();
				}
			}));
		}
		this._register(editor.onDidChangeStatus(message => this.setStatus(message)));
	}
	override get widgets(): readonly IBrowserEditorWidget[] {
		return [
			{ location: BrowserWidgetLocation.ContentArea, element: this.status, order: 0 },
			{ location: BrowserWidgetLocation.ContentArea, element: this.downloads, order: 1 },
			{ location: BrowserWidgetLocation.ContentArea, element: this.userControl, order: 2 },
		];
	}
	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		this.render(model.state);
		this.userControl.hidden = !model.state.userControlRequestId;
		let previous = model.state;
		store.add(model.onDidChangeState(state => {
			// Picker and DevTools updates must not overwrite selection announcements.
			if (state.url !== previous.url || state.title !== previous.title || state.loading !== previous.loading || state.errorDescription !== previous.errorDescription) {
				this.render(state);
			}
			this.userControl.hidden = !state.userControlRequestId;
			previous = state;
		}));
		store.add(model.onDidEvent(event => this.accept(event)));
	}
	override onModelDetached(): void {
		this.setStatus('', false);
		this.userControl.hidden = true;
		this.downloads.hidden = true;
	}
	public render(state: IBrowserViewState): void {
		this.setStatus(state.errorDescription
			? localize({ bundle: 'ash.workbench', key: 'browser.loadFailure' }, 'Unable to load page: {0}', state.errorDescription)
			: state.loading ? localize({ bundle: 'ash.workbench', key: 'browser.loading' }, 'Loading page…') : state.title || state.url, !!state.errorDescription);
	}
	private setStatus(message: string, visible = true): void {
		this.status.classList.toggle('announcement-only', !visible);
		this.status.textContent = message;
	}
	public accept(event: BrowserViewEvent): void {
		if (event.type === 'loadFailed') { this.setStatus(localize({ bundle: 'ash.workbench', key: 'browser.loadFailure' }, 'Unable to load page: {0}', event.errorDescription)); }
		if (event.type === 'renderProcessGone') { this.setStatus(localize({ bundle: 'ash.workbench', key: 'browser.processGone' }, 'Page stopped: {0}', event.reason)); }
		if (event.type === 'downloadProgress') {
			this.downloads.hidden = false;
			const state = event.state === 'progressing' ? localize({ bundle: 'ash.workbench', key: 'browser.downloading' }, 'downloading')
				: event.state === 'completed' ? localize({ bundle: 'ash.workbench', key: 'browser.downloadCompleted' }, 'completed')
					: event.state === 'cancelled' ? localize({ bundle: 'ash.workbench', key: 'browser.downloadCancelled' }, 'cancelled') : localize({ bundle: 'ash.workbench', key: 'browser.downloadInterrupted' }, 'interrupted');
			this.downloads.textContent = localize({ bundle: 'ash.workbench', key: 'browser.downloadProgress' }, '{0}: {1} / {2} bytes ({3})', event.filename, event.receivedBytes, event.totalBytes, state);
		}
	}
}
