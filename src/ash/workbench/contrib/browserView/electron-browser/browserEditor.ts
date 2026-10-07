import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { localize } from '../../../../nls.js';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IBrowserViewService, type IBrowserViewState } from '../../../../platform/browserView/common/browserView.js';
import { BrowserEditorInput } from '../common/browserEditorInput.js';
import type { IBrowserViewModel } from '../common/browserView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService, DialogSeverity } from '../../../../platform/dialogs/common/dialogs.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IDialogsModel } from '../../../common/dialogs.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import './media/browser.css';

/** Workbench controls and geometry for one Main-owned web page. */
export class BrowserEditor extends EditorPane implements IEditorPane {
	static readonly ID = 'ash.editor.browser';
	readonly id = BrowserEditor.ID;
	private domNode!: HTMLDivElement;
	private addressDomNode!: HTMLInputElement;
	private viewportDomNode!: HTMLDivElement;
	private statusDomNode!: HTMLDivElement;
	private downloadDomNode!: HTMLDivElement;
	private backDomNode!: HTMLButtonElement;
	private forwardDomNode!: HTMLButtonElement;
	private reloadDomNode!: HTMLButtonElement;
	private model: IBrowserViewModel | undefined;
	private readonly modelListeners = this._register(new DisposableStore());
	private targetId: string | undefined;
	private visible = false;
	private menuVisible = false;
	private focusOutside = false;
	private update: Promise<void> = Promise.resolve();
	private sharingToolbar!: WorkbenchToolBar;

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IDialogsModel private readonly dialogs: IDialogsModel,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IChatSessionNavigationService private readonly conversations: IChatSessionNavigationService,
		@IBrowserViewService private readonly pageService: IBrowserViewService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(BrowserEditor.ID, themeService, storageService);
		this._register(dialogs.onWillShowDialog(() => this.refreshLayout()));
		this._register(dialogs.onDidCloseDialog(() => this.refreshLayout()));
		this._register(menus.onDidShowContextMenu(() => { this.menuVisible = true; this.refreshLayout(); }));
		this._register(menus.onDidHideContextMenu(() => { this.menuVisible = false; this.refreshLayout(); }));
		this._register(toDisposable(() => {
			if (this.targetId && visiblePanes.get(this.targetId) === this) { visiblePanes.delete(this.targetId); }
		}));
	}

	public override create(container: HTMLElement): void {
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-browser-editor';
		const toolbar = h(document, 'div');
		toolbar.className = 'ash-browser-toolbar';
		toolbar.setAttribute('role', 'toolbar');
		toolbar.setAttribute('aria-label', 'Browser navigation');
		const button = (label: string, action: () => Promise<void>): HTMLButtonElement => {
			const element = h(document, 'button'); element.type = 'button'; element.textContent = label;
			this._register(addDisposableListener(element, 'click', () => { void action().catch(error => this.report(error)); }));
			toolbar.append(element); return element;
		};
		this.backDomNode = button('Back', () => this.target().goBack());
		this.forwardDomNode = button('Forward', () => this.target().goForward());
		this.reloadDomNode = button('Reload', () => this.model?.state.loading ? this.target().stop() : this.target().reload());
		this.addressDomNode = h(document, 'input');
		this.addressDomNode.type = 'url'; this.addressDomNode.setAttribute('aria-label', 'Browser address');
		this.addressDomNode.disabled = true;
		this.addressDomNode.spellcheck = false;
		toolbar.append(this.addressDomNode);
		button('Go', () => this.navigate());
		button('Help', () => this.showHelp());
		const sharing = h(document, 'div');
		toolbar.append(sharing);
		this.sharingToolbar = this._register(new WorkbenchToolBar(sharing, this.menus, { ariaLabel: localize({ bundle: 'ash.workbench', key: 'browser.pageActions' }, 'Page actions') }));
		this.setPageActions();
		this.statusDomNode = h(document, 'div'); this.statusDomNode.className = 'ash-browser-status';
		this.statusDomNode.setAttribute('role', 'status');
		this.downloadDomNode = h(document, 'div'); this.downloadDomNode.className = 'ash-browser-status';
		this.downloadDomNode.hidden = true; this.downloadDomNode.setAttribute('role', 'status');
		this.downloadDomNode.setAttribute('aria-label', localize({ bundle: 'ash.workbench', key: 'browser.downloads' }, 'Downloads'));
		this.viewportDomNode = h(document, 'div'); this.viewportDomNode.className = 'ash-browser-viewport';
		this.viewportDomNode.tabIndex = 0;
		this.viewportDomNode.setAttribute('aria-label', 'Webpage. Press F6 to return to the address field.');
		this._register(addDisposableListener(this.viewportDomNode, 'focus', () => { this.focusOutside = false; this.refreshLayout(); void this.update.then(() => this.target().focus()).catch(error => this.report(error)); }));
		this.domNode.append(toolbar, this.statusDomNode, this.downloadDomNode, this.viewportDomNode); container.append(this.domNode);
		super.create(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener<KeyboardEvent>(this.domNode, 'keydown', event => {
			if (event.key === 'Enter' && event.target === this.addressDomNode) { event.preventDefault(); void this.navigate().catch(error => this.report(error)); }
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); this.focus(); }
		}));
		this._register(AccessibleViewRegistry.register({
			// Each split owns a provider; focus selects the relevant pane at invocation time.
			type: AccessibleViewType.Help, priority: 100, name: 'browserHelp:' + crypto.randomUUID(),
			when: ActiveEditorContext.isEqualTo(BrowserEditor.ID),
			getProvider: () => {
				const focused = document.activeElement;
				if (!this.visible || !(focused instanceof HTMLElement) || !this.domNode.contains(focused)) { return undefined; }
				return new AccessibleContentProvider(AccessibleViewProviderId.Browser, { type: AccessibleViewType.Help },
					() => this.helpContent(), () => focused.focus(), AccessibilityVerbositySettingId.Browser);
			},
		}));
		const observer = new ResizeObserver(() => this.refreshLayout()); observer.observe(this.viewportDomNode);
		this._register(toDisposable(() => observer.disconnect()));
		this._register(addDisposableListener(document.defaultView!, 'resize', () => this.refreshLayout()));
		this._register(addDisposableListener<FocusEvent>(document, 'focusin', event => {
			this.focusOutside = event.target instanceof Node && !this.domNode.contains(event.target);
			this.refreshLayout();
		}));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!(input instanceof BrowserEditorInput)) { throw new TypeError('Expected browser editor input'); }
		const model = await input.resolve();
		signal.throwIfAborted();
		this.modelListeners.clear();
		this.model = model;
		this.addressDomNode.disabled = false;
		this.targetId = model.id;
		this.setPageActions();
		this.modelListeners.add(model.onDidChangeState(state => this.render(state)));
		this.modelListeners.add(model.onDidEvent(event => {
			if (event.type === 'focusAddress') { this.focus(); }
			if (event.type === 'loadFailed') { this.statusDomNode.textContent = `Unable to load page: ${event.errorDescription}`; }
			if (event.type === 'renderProcessGone') { this.statusDomNode.textContent = `Page stopped: ${event.reason}`; }
			if (event.type === 'downloadProgress') { this.downloadDomNode.hidden = false; this.downloadDomNode.textContent = localize({ bundle: 'ash.workbench', key: 'browser.downloadProgress' }, '{0}: {1} / {2} bytes ({3})', event.filename, event.receivedBytes, event.totalBytes, downloadState(event.state)); }
		}));
		this.render(model.state);
		this.refreshLayout();
	}
	public override clearInput(): void { this.visible = false; this.addressDomNode.disabled = true; this.refreshLayout(); this.modelListeners.clear(); }
	public override layout(_dimension: IDimension): void { this.refreshLayout(); }
	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility); this.visible = visibility; this.refreshLayout();
	}
	public override focus(): void {
		this.addressDomNode.focus(); this.addressDomNode.select();
		if (this.configuration.getValue<boolean>('accessibility.verbosity.browser')) {
			this.statusDomNode.textContent = 'Enter a URL and press Enter. Press Alt+F1 for browser help.';
		}
	}
	private target(): IBrowserViewModel {
		if (!this.model) { throw new Error('Browser page is closed'); }
		return this.model;
	}
	private navigate(): Promise<void> { return this.target().loadURL(this.addressDomNode.value.trim()); }
	private setPageActions(): void {
		this.sharingToolbar.setActions([
			{ id: 'browser.share', label: localize({ bundle: 'ash.workbench', key: 'browser.share' }, 'Share with Agent'), enabled: this.model?.info.owner.type === 'user', tooltip: '', run: () => this.share().catch(error => this.report(error)) },
			{ id: 'browser.permissions', label: localize({ bundle: 'ash.workbench', key: 'browser.resetPermissions' }, 'Reset all website permissions'), enabled: true, tooltip: '', run: () => this.pageService.clearPermissions(this.target().id).catch(error => this.report(error)) },
			{ id: 'browser.cancelDownloads', label: localize({ bundle: 'ash.workbench', key: 'browser.cancelDownloads' }, 'Cancel downloads'), enabled: true, tooltip: '', run: () => this.pageService.cancelDownloads(this.target().id).catch(error => this.report(error)) },
		]);
	}
	private async share(): Promise<void> {
		const model = this.target();
		if (model.info.owner.type !== 'user') { return; }
		const audience = await model.getSharing();
		const choices = this.conversations.getConversations();
		const result = await this.dialogService.prompt<readonly string[]>({
			title: localize({ bundle: 'ash.workbench', key: 'browser.share' }, 'Share with Agent'),
			message: localize({ bundle: 'ash.workbench', key: 'browser.shareDescription' }, 'Allow a conversation to observe this page, including its signed-in content. Agent input and navigation require an isolated Agent page. Access ends when you revoke it or this connection closes.'),
			detail: audience.length ? localize({ bundle: 'ash.workbench', key: 'browser.shared' }, 'This page is currently shared.') : localize({ bundle: 'ash.workbench', key: 'browser.private' }, 'This page is private.'),
			buttons: [
				...choices.map(choice => ({ label: choice.title, run: () => [choice.threadId] })),
				{ label: localize({ bundle: 'ash.workbench', key: 'browser.revoke' }, 'Revoke all access'), run: () => [] },
			],
			cancelButton: localize({ bundle: 'ash.workbench', key: 'browser.cancel' }, 'Cancel'),
		});
		if (result.result !== undefined) {
			await model.setSharing(result.result);
			this.statusDomNode.textContent = result.result.length ? localize({ bundle: 'ash.workbench', key: 'browser.shared' }, 'This page is currently shared.') : localize({ bundle: 'ash.workbench', key: 'browser.private' }, 'This page is private.');
		}
	}
	private render(state: IBrowserViewState): void {
		if (this.addressDomNode.ownerDocument.activeElement !== this.addressDomNode) { this.addressDomNode.value = state.url; }
		this.backDomNode.disabled = !state.canGoBack; this.forwardDomNode.disabled = !state.canGoForward;
		this.reloadDomNode.textContent = state.loading ? 'Stop' : 'Reload';
		this.statusDomNode.textContent = state.errorDescription ? localize({ bundle: 'ash.workbench', key: 'browser.loadFailure' }, 'Unable to load page: {0}', state.errorDescription) : state.loading ? 'Loading page…' : state.title || state.url;
	}
	private refreshLayout(): void {
		if (!this.targetId || !this.viewportDomNode || this.isDisposed) { return; }
		const targetId = this.targetId;
		const model = this.target();
		if (this.visible) { visiblePanes.set(targetId, this); }
		else if (visiblePanes.get(targetId) === this) { visiblePanes.delete(targetId); }
		this.update = this.update.then(async () => {
			if (this.targetId !== targetId || this.isDisposed) { return; }
			if (visiblePanes.get(targetId) && visiblePanes.get(targetId) !== this) { return; }
			const bounds = this.viewportDomNode.getBoundingClientRect();
			const visible = this.visible && !this.menuVisible && !this.focusOutside && this.dialogs.dialogs.length === 0 && bounds.width > 0 && bounds.height > 0;
			if (visible) {
				await model.layout({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) });
			}
			await model.setVisible(visible);
		}).catch(error => this.report(error));
	}
	private report(error: unknown): void { if (!this.isDisposed) { this.statusDomNode.textContent = error instanceof Error ? error.message : String(error); } }
	private helpContent(): string {
		return localize({ bundle: 'ash.workbench', key: 'browser.accessibilityHelp' }, 'Use Tab to move through browser controls. Enter in the address field navigates. Ctrl+L (Command+L on macOS) or F6 in the webpage returns to the address field. Back and Forward navigate page history. Close the editor tab to close its webpage. Set workbench.externalUriOpeners to ash.browser.open for websites you want to open here. Webpages use the browser’s accessibility tree. Share with Agent allows a chosen conversation to observe this page. Agent input and navigation require an isolated Agent page. Revoke all access ends that grant. Website permission dialogs name the requesting site. Reset all website permissions removes its decisions. Downloads ask for a save location; Cancel downloads stops active transfers.');
	}

	private showHelp(): Promise<void> {
		return this.dialogService.showMessage({ severity: DialogSeverity.Info, title: 'Browser accessibility help', message: this.helpContent() });
	}
}

// A moved tab can create its new pane before the old pane is disposed.
const visiblePanes = new Map<string, BrowserEditor>();

function downloadState(state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'): string {
	switch (state) {
		case 'progressing': return localize({ bundle: 'ash.workbench', key: 'browser.downloading' }, 'downloading');
		case 'completed': return localize({ bundle: 'ash.workbench', key: 'browser.downloadCompleted' }, 'completed');
		case 'cancelled': return localize({ bundle: 'ash.workbench', key: 'browser.downloadCancelled' }, 'cancelled');
		case 'interrupted': return localize({ bundle: 'ash.workbench', key: 'browser.downloadInterrupted' }, 'interrupted');
	}
}
