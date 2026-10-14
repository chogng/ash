import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { localize } from '../../../../nls.js';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IBrowserViewService, BrowserViewStorageScope, type IBrowserViewState } from '../../../../platform/browserView/common/browserView.js';
import { BrowserEditorInput } from '../common/browserEditorInput.js';
import { BrowserViewEditorId, type IBrowserViewModel } from '../common/browserView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService, DialogSeverity } from '../../../../platform/dialogs/common/dialogs.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { WebContentsViewHost } from './webContentsViewHost.js';
import { BrowserEditorChatIntegration } from './features/browserEditorChatFeatures.js';
import { BrowserEditorFindFeature } from './features/browserEditorFindFeature.js';
import { BrowserElementSelectionMode, type IBrowserViewWindowConfiguration } from '../../../../platform/browserView/common/browserView.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { filterQuickPickItems } from '../../../../platform/quickinput/browser/quickInputList.js';
import './media/browser.css';

/** Workbench controls for one Main-owned web page. */
export class BrowserEditor extends EditorPane implements IEditorPane {
	readonly id = BrowserViewEditorId;
	private domNode!: HTMLDivElement;
	private addressDomNode!: HTMLInputElement;
	private viewportDomNode!: HTMLDivElement;
	private statusDomNode!: HTMLDivElement;
	private downloadDomNode!: HTMLDivElement;
	private addressInput!: InputBox;
	private navigationToolbar!: WorkbenchToolBar;
	private navigationActions: readonly IAction[] = [];
	private model: IBrowserViewModel | undefined;
	private readonly modelListeners = this._register(new DisposableStore());
	private pageHost!: WebContentsViewHost;
	private visible = false;
	private sharingToolbar!: WorkbenchToolBar;
	private readonly historyPicker = this._register(new MutableDisposable<DisposableStore>());
	private readonly chatIntegration: BrowserEditorChatIntegration;
	private readonly findFeature: BrowserEditorFindFeature;

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IChatSessionNavigationService private readonly conversations: IChatSessionNavigationService,
		@IBrowserViewService private readonly pageService: IBrowserViewService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IEditorPart private readonly editorPart: IEditorPart,
		@IThemeService private readonly browserThemes: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(BrowserViewEditorId, browserThemes, storageService);
		this.chatIntegration = this._register(instantiation.createInstance(BrowserEditorChatIntegration));
		this.findFeature = this._register(instantiation.createInstance(BrowserEditorFindFeature));
		this._register(browserThemes.onDidColorThemeChange(() => {
			if (this.model) { void this.configurePreload(this.model).catch(error => this.report(error)); }
		}));
	}

	public override create(container: HTMLElement): void {
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-browser-editor';
		const toolbar = h(document, 'div');
		toolbar.className = 'ash-browser-toolbar';
		const navigation = h(document, 'div');
		navigation.className = 'ash-browser-navigation';
		toolbar.append(navigation);
		this.navigationToolbar = this._register(new WorkbenchToolBar(navigation, this.menus, { ariaLabel: localize({ bundle: 'ash.workbench', key: 'browser.navigationToolbar' }, 'Browser navigation') }));
		this.setNavigationActions();
		this.addressInput = this._register(new InputBox(toolbar, { presentation: 'compact', enabled: false, ariaLabel: localize({ bundle: 'ash.workbench', key: 'browser.address' }, 'Browser address') }));
		this.addressInput.element.classList.add('ash-browser-address');
		this.addressDomNode = this.addressInput.inputElement;
		this.addressDomNode.type = 'url';
		const sharing = h(document, 'div');
		sharing.className = 'ash-browser-page-actions';
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
		this.viewportDomNode.setAttribute('aria-label', localize({ bundle: 'ash.workbench', key: 'browser.webpage' }, 'Webpage. Press F6 to return to the address field.'));
		this.pageHost = this._register(this.instantiation.createInstance(WebContentsViewHost, document.defaultView!));
		this.pageHost.onContainerCreated(this.viewportDomNode);
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
			when: ActiveEditorContext.isEqualTo(BrowserViewEditorId),
			getProvider: () => {
				const focused = document.activeElement;
				if (!this.visible || !(focused instanceof HTMLElement) || !this.domNode.contains(focused)) { return undefined; }
				return new AccessibleContentProvider(AccessibleViewProviderId.Browser, { type: AccessibleViewType.Help },
					() => this.helpContent(), () => focused.focus(), AccessibilityVerbositySettingId.Browser);
			},
		}));
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.View, priority: 100, name: 'browserSelections:' + crypto.randomUUID(),
			when: ActiveEditorContext.isEqualTo(BrowserViewEditorId),
			getProvider: () => {
				const content = this.chatIntegration.getAccessibleContent();
				if (!this.visible || !content) { return undefined; }
				return new AccessibleContentProvider(AccessibleViewProviderId.Browser, { type: AccessibleViewType.View }, () => content, () => this.pageHost.tryFocus(), AccessibilityVerbositySettingId.Browser);
			},
		}));
		const observer = new ResizeObserver(entries => {
			// The root owns available width. Changing its child's height must not feed back into the observed size.
			if (entries.some(entry => entry.target === this.domNode)) { toolbar.classList.toggle('compact', toolbar.clientWidth < 320); }
			this.pageHost.layout();
		});
		observer.observe(this.domNode);
		this._register(toDisposable(() => observer.disconnect()));
		this._register(addDisposableListener(this.domNode, 'focusin', () => this.pageHost.setVisible(this.visible)));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!(input instanceof BrowserEditorInput)) { throw new TypeError('Expected browser editor input'); }
		const model = await input.resolve();
		signal.throwIfAborted();
		this.modelListeners.clear();
		this.historyPicker.clear();
		this.model = model;
		await this.configurePreload(model);
		signal.throwIfAborted();
		this.findFeature.setModel(model);
		this.chatIntegration.setModel(model, message => { if (this.model === model && !this.isDisposed) { this.statusDomNode.textContent = message; } });
		this.addressInput.enabled = true;
		this.pageHost.setModel(model);
		this.setPageActions();
		this.modelListeners.add(model.onDidChangeState(state => this.render(state)));
		this.modelListeners.add(model.onDidEvent(event => {
			if (event.type === 'keyDown' && this.pageHost.isActive) {
				const group = this.editorPart.groups.find(group => group.activePane === this);
				if (group) { this.editorPart.activateGroup(group.id); }
				const key = event.event;
				if (key.key === 'F6' || ((key.ctrlKey || key.metaKey) && key.key.toLowerCase() === 'l')) { this.focus(); }
				else if ((key.ctrlKey || key.metaKey) && key.key.toLowerCase() === 'f') { void this.findFeature.show().catch(error => this.report(error)); }
				else if (key.key === 'F3') { void this.findFeature.next(!key.shiftKey).catch(error => this.report(error)); }
				else { this.viewportDomNode.dispatchEvent(new KeyboardEvent('keydown', { ...key, bubbles: true, cancelable: true })); }
			}
			if (event.type === 'focusAddress') { this.focus(); }
			if (event.type === 'loadFailed') { this.statusDomNode.textContent = localize({ bundle: 'ash.workbench', key: 'browser.loadFailure' }, 'Unable to load page: {0}', event.errorDescription); }
			if (event.type === 'renderProcessGone') { this.statusDomNode.textContent = localize({ bundle: 'ash.workbench', key: 'browser.processGone' }, 'Page stopped: {0}', event.reason); }
			if (event.type === 'downloadProgress') { this.downloadDomNode.hidden = false; this.downloadDomNode.textContent = localize({ bundle: 'ash.workbench', key: 'browser.downloadProgress' }, '{0}: {1} / {2} bytes ({3})', event.filename, event.receivedBytes, event.totalBytes, downloadState(event.state)); }
		}));
		this.render(model.state);
		this.pageHost.layout();
	}
	public override clearInput(): void {
		this.chatIntegration.setModel(undefined, () => { });
		this.findFeature.setModel(undefined);
		this.historyPicker.clear();
		this.visible = false;
		this.pageHost.setVisible(false);
		this.pageHost.setModel(undefined);
		this.modelListeners.clear();
		this.model = undefined;
		this.addressInput.enabled = false;
		this.addressDomNode.value = '';
		this.statusDomNode.textContent = '';
		this.downloadDomNode.hidden = true;
		this.setNavigationActions();
	}
	public override layout(_dimension: IDimension): void { this.pageHost.layout(); }
	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility); this.visible = visibility; this.pageHost.setVisible(visibility);
	}
	public override focus(): void {
		this.addressDomNode.focus(); this.addressDomNode.select();
		if (this.configuration.getValue<boolean>('accessibility.verbosity.browser')) {
			this.statusDomNode.textContent = localize({ bundle: 'ash.workbench', key: 'browser.focusHelp' }, 'Enter a URL and press Enter. Press Alt+F1 for browser help.');
		}
	}
	private target(): IBrowserViewModel {
		if (!this.model) { throw new Error('Browser page is closed'); }
		return this.model;
	}
	private async navigate(): Promise<void> {
		const model = this.target();
		const url = this.addressDomNode.value.trim();
		const document = this.addressDomNode.ownerDocument;
		const focused = document.activeElement;
		await model.loadURL(url);
		// Navigation can finish after the user moves to another pane, edits the URL or opens an overlay.
		if (!this.isDisposed && this.visible && this.model === model && document.activeElement === focused && this.addressDomNode.value.trim() === url) {
			this.pageHost.tryFocus();
		}
	}
	private setNavigationActions(state?: IBrowserViewState): void {
		const back = localize({ bundle: 'ash.workbench', key: 'browser.back' }, 'Back');
		const forward = localize({ bundle: 'ash.workbench', key: 'browser.forward' }, 'Forward');
		const reload = state?.loading ? localize({ bundle: 'ash.workbench', key: 'browser.stop' }, 'Stop') : localize({ bundle: 'ash.workbench', key: 'browser.reload' }, 'Reload');
		const actions: readonly IAction[] = [
			{ id: 'browser.back', label: back, tooltip: back, icon: Lxicon.arrowLeft, enabled: state?.canGoBack === true, run: () => this.target().goBack().catch(error => this.report(error)) },
			{ id: 'browser.forward', label: forward, tooltip: forward, icon: Lxicon.arrowRight, enabled: state?.canGoForward === true, run: () => this.target().goForward().catch(error => this.report(error)) },
			{ id: 'browser.reload', label: reload, tooltip: reload, icon: state?.loading ? Lxicon.close : Lxicon.refresh, enabled: state !== undefined, run: () => (this.model?.state.loading ? this.target().stop() : this.target().reload()).catch(error => this.report(error)) },
		];
		// Keep retained action identities through title/URL updates so keyboard focus and DOM stay stable.
		this.navigationActions = actions.map((action, index) => {
			const previous = this.navigationActions[index];
			return previous?.label === action.label && previous.enabled === action.enabled && previous.icon === action.icon ? previous : action;
		});
		this.navigationToolbar.setActions(this.navigationActions);
	}
	private setPageActions(): void {
		const go = localize({ bundle: 'ash.workbench', key: 'browser.go' }, 'Go');
		const help = localize({ bundle: 'ash.workbench', key: 'browser.help' }, 'Help');
		this.sharingToolbar.setActions([
			{ id: 'browser.go', label: go, tooltip: go, icon: Lxicon.arrowRight, enabled: true, run: () => this.navigate().catch(error => this.report(error)) },
			{ id: 'browser.help', label: help, tooltip: help, icon: Lxicon.question, enabled: true, run: () => this.showHelp().catch(error => this.report(error)) },
		], [
			{ id: 'browser.find', label: localize({ bundle: 'ash.workbench', key: 'browser.find' }, 'Find in Page'), enabled: !!this.model, tooltip: '', run: () => this.findFeature.show().catch(error => this.report(error)) },
			{ id: 'browser.selectElement', label: localize({ bundle: 'ash.workbench', key: 'browser.selectElement' }, 'Select Element for Chat'), enabled: !!this.model, tooltip: '', run: () => this.target().toggleElementSelection(true, { highlightFocusedElement: true }).catch(error => this.report(error)) },
			{ id: 'browser.commentElement', label: localize({ bundle: 'ash.workbench', key: 'browser.commentElement' }, 'Comment on Elements'), enabled: !!this.model, tooltip: '', run: () => this.target().toggleElementSelection(true, { continuous: true, mode: BrowserElementSelectionMode.Comment, highlightFocusedElement: true }).catch(error => this.report(error)) },
			{ id: 'browser.selectArea', label: localize({ bundle: 'ash.workbench', key: 'browser.selectArea' }, 'Select Area for Chat'), enabled: !!this.model, tooltip: '', run: () => this.target().toggleAreaSelection(true).catch(error => this.report(error)) },
			{ id: 'browser.share', label: localize({ bundle: 'ash.workbench', key: 'browser.share' }, 'Share with Agent'), enabled: this.model?.info.owner.type === 'user', tooltip: '', run: () => this.share().catch(error => this.report(error)) },
			{ id: 'browser.permissions', label: localize({ bundle: 'ash.workbench', key: 'browser.resetPermissions' }, 'Reset all website permissions'), enabled: true, tooltip: '', run: () => this.pageService.clearPermissions(this.target().id).catch(error => this.report(error)) },
			{ id: 'browser.cancelDownloads', label: localize({ bundle: 'ash.workbench', key: 'browser.cancelDownloads' }, 'Cancel downloads'), enabled: true, tooltip: '', run: () => this.pageService.cancelDownloads(this.target().id).catch(error => this.report(error)) },
			{ id: 'browser.history', label: localize({ bundle: 'ash.workbench', key: 'browser.history' }, 'History'), enabled: this.model?.info.session.scope === BrowserViewStorageScope.Workspace || this.model?.info.session.scope === BrowserViewStorageScope.Global, tooltip: '', run: () => this.showHistory().catch(error => this.report(error)) },
		]);
	}

	private async showHistory(): Promise<void> {
		const model = this.target();
		const snapshot = await this.pageService.getBrowserHistory(model.id);
		if (this.isDisposed || this.model !== model) { return; }
		const resources = new DisposableStore();
		this.historyPicker.value = resources;
		const picker = resources.add(this.quickInput.createQuickPick<IQuickPickItem & { url?: string; }>());
		resources.add(toDisposable(() => picker.hide()));
		picker.ariaLabel = localize({ bundle: 'ash.workbench', key: 'browser.history' }, 'History');
		picker.placeholder = localize({ bundle: 'ash.workbench', key: 'browser.historySearch' }, 'Search browsing history');
		picker.sortByLabel = false;
		const items = [...snapshot.items].reverse().map(entry => ({ label: entry.title || entry.url, description: entry.url, url: entry.url }));
		const render = (): void => {
			picker.items = [...filterQuickPickItems(items, picker.value), { label: localize({ bundle: 'ash.workbench', key: 'browser.clearHistory' }, 'Clear browsing history'), alwaysShow: true }];
		};
		resources.add(picker.onDidChangeValue(render));
		resources.add(picker.onDidHide(() => { if (this.historyPicker.value === resources) { this.historyPicker.clear(); } }));
		resources.add(picker.onDidAccept(() => {
			const selected = picker.selectedItems[0];
			if (!selected || this.model !== model) { return; }
			picker.hide();
			void (selected.url ? model.loadURL(selected.url) : this.pageService.deleteBrowserHistory(model.id)).catch(error => this.report(error));
		}));
		render();
		picker.show();
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
		this.setNavigationActions(state);
		this.statusDomNode.textContent = state.errorDescription ? localize({ bundle: 'ash.workbench', key: 'browser.loadFailure' }, 'Unable to load page: {0}', state.errorDescription) : state.loading ? localize({ bundle: 'ash.workbench', key: 'browser.loading' }, 'Loading page…') : state.title || state.url;
	}
	private report(error: unknown): void { if (!this.isDisposed) { this.statusDomNode.textContent = error instanceof Error ? error.message : String(error); } }
	private configurePreload(model: IBrowserViewModel): Promise<void> {
		const theme = this.browserThemes.getColorTheme();
		const configuration: IBrowserViewWindowConfiguration = {
			theme: {
				focusBorder: theme.getColorCss('focusBorder'), buttonBackground: theme.getColorCss('button.background'), buttonForeground: theme.getColorCss('button.foreground'),
				widgetBackground: theme.getColorCss('editorWidget.background'), widgetForeground: theme.getColorCss('editorWidget.foreground'), widgetBorder: theme.getColorCss('widget.border'), contrastBorder: theme.getColorCss('contrastBorder'),
			},
			localizedStrings: {
				addComment: localize({ bundle: 'ash.workbench', key: 'browser.addComment' }, 'Add Comment'),
				addCommentPlaceholder: localize({ bundle: 'ash.workbench', key: 'browser.commentPlaceholder' }, 'Add a comment'),
				commentOnSelectedElement: localize({ bundle: 'ash.workbench', key: 'browser.commentOnSelectedElement' }, 'Comment on selected element'),
				elementComment: localize({ bundle: 'ash.workbench', key: 'browser.elementComment' }, 'Element comment {0}'),
				elementCommentWithBody: localize({ bundle: 'ash.workbench', key: 'browser.elementCommentWithBody' }, 'Element comment {0}: {1}'),
				emptyElementComment: localize({ bundle: 'ash.workbench', key: 'browser.emptyElementComment' }, 'Empty element comment {0}'),
				removeComment: localize({ bundle: 'ash.workbench', key: 'browser.removeComment' }, 'Remove Comment'),
				removeElementComment: localize({ bundle: 'ash.workbench', key: 'browser.removeElementComment' }, 'Remove element comment'),
				cancel: localize({ bundle: 'ash.workbench', key: 'browser.cancel' }, 'Cancel'),
				selectionHelp: localize({ bundle: 'ash.workbench', key: 'browser.selectionHelp' }, 'Select with the mouse. For elements, use Tab to choose, Up or Down to move through ancestors, and Enter to select. For areas, use arrow keys to position the selection and Enter to capture. Escape cancels.'),
			},
		};
		return this.pageService.updateWindowConfiguration(model.info.host.windowId, configuration);
	}
	private helpContent(): string {
		return localize({ bundle: 'ash.workbench', key: 'browser.accessibilityHelp' }, 'Use Tab to move through browser controls. Enter in the address field navigates and focuses the webpage. Ctrl+Shift+P (Command+Shift+P on macOS) opens the Command Palette from the webpage. Ctrl+L (Command+L on macOS) or F6 in the webpage returns to the address field. Back and Forward navigate page history. Close the editor tab to close its webpage. Set workbench.externalUriOpeners to ash.browser.open for websites you want to open here. Webpages use the browser’s accessibility tree. The More Actions menu contains sharing, website permission reset, download cancellation and History. History lists visits in this storage session; type to search, use Up and Down to choose a page and Enter to open it. Clear browsing history removes this session’s recorded visits. Isolated Agent pages and ephemeral sessions do not record history. Share with Agent allows a chosen conversation to observe this page. Agent input and navigation require an isolated Agent page. Revoke all access ends that grant. Website permission dialogs name the requesting site. Reset all website permissions removes its decisions. Downloads ask for a save location; Cancel downloads stops active transfers. Use Ctrl+F to find the selected text in the page and F3 or Shift+F3 to move between matches. More Actions also offers Select Element for Chat, Comment on Elements and Select Area for Chat. Use Tab and arrow keys to choose an element, Enter to select, and Escape to cancel. Area selection supports arrow keys and Enter. Comments support keyboard editing and removal. Captured selections remain private until you explicitly choose Browser selections in Chat’s Add Context menu.');
	}

	private showHelp(): Promise<void> {
		return this.dialogService.showMessage({ severity: DialogSeverity.Info, title: localize({ bundle: 'ash.workbench', key: 'browser.accessibilityHelpTitle' }, 'Browser accessibility help'), message: this.helpContent() });
	}
}

function downloadState(state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'): string {
	switch (state) {
		case 'progressing': return localize({ bundle: 'ash.workbench', key: 'browser.downloading' }, 'downloading');
		case 'completed': return localize({ bundle: 'ash.workbench', key: 'browser.downloadCompleted' }, 'completed');
		case 'cancelled': return localize({ bundle: 'ash.workbench', key: 'browser.downloadCancelled' }, 'cancelled');
		case 'interrupted': return localize({ bundle: 'ash.workbench', key: 'browser.downloadInterrupted' }, 'interrupted');
	}
}
