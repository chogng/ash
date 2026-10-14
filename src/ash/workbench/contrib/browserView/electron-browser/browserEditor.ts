import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { localize } from '../../../../nls.js';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
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
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { BrowserNavigationFeatures } from './features/browserNavigationFeatures.js';
import { BrowserHistoryFeature } from './features/browserHistoryFeature.js';
import { BrowserPermissionsFeature } from './features/browserPermissionsFeature.js';
import { BrowserEditorZoomSupport } from './features/browserEditorZoomFeature.js';
import { BrowserEditorEmulationSupport } from './features/browserEditorEmulationFeatures.js';
import { BrowserWelcomeFeature } from './features/browserWelcomeFeature.js';
import { WebContentsViewRendererFeature } from './features/webContentsViewRendererFeature.js';
import { BrowserEditorErrorFeatures } from './features/browserEditorErrorFeatures.js';
import { BrowserFavoritesFeature } from './features/browserFavoritesFeature.js';
import { IBrowserAutoReloadService } from './features/browserAutoReloadFeatures.js';
import { BrowserRemoteIndicatorContribution } from './features/browserRemoteFeatures.js';
import './media/browser.css';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

/** URL suggestions are supplied by their existing history/favorites owners. */
export interface IBrowserUrlSuggestion {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	apply(input: BrowserEditorInput): void | Promise<void>;
}
export interface IBrowserUrlSuggestionContext { readonly text: string; readonly input: BrowserEditorInput; }
export interface IBrowserUrlSuggestionProvider {
	readonly label?: string;
	readonly order?: number;
	readonly onDidChange?: import('../../../../base/common/event.js').Event<void>;
	getSuggestions(context: IBrowserUrlSuggestionContext, token: import('../../../../base/common/cancellation.js').CancellationToken): Promise<readonly IBrowserUrlSuggestion[]>;
}

/** Workbench controls for one Main-owned web page. */
export class BrowserEditor extends EditorPane implements IEditorPane {
	readonly id = BrowserViewEditorId;
	private domNode!: HTMLDivElement;
	private addressDomNode!: HTMLInputElement;
	private viewportDomNode!: HTMLDivElement;
	private statusDomNode!: HTMLDivElement;
	private downloadDomNode!: HTMLDivElement;
	private navigation!: BrowserNavigationFeatures;
	private currentInput: BrowserEditorInput | undefined;
	private model: IBrowserViewModel | undefined;
	private actionsUrl: string | undefined;
	private readonly modelListeners = this._register(new DisposableStore());
	private pageHost!: WebContentsViewHost;
	private renderer!: WebContentsViewRendererFeature;
	private welcome!: BrowserWelcomeFeature;
	private pageStatus!: BrowserEditorErrorFeatures;
	private remoteIndicator!: BrowserRemoteIndicatorContribution;
	private visible = false;
	private sharingToolbar!: WorkbenchToolBar;
	private readonly history: BrowserHistoryFeature;
	private readonly permissions: BrowserPermissionsFeature;
	private readonly zoom: BrowserEditorZoomSupport;
	private readonly emulation: BrowserEditorEmulationSupport;
	private readonly favorites: BrowserFavoritesFeature;

	private readonly chatIntegration: BrowserEditorChatIntegration;
	private readonly findFeature: BrowserEditorFindFeature;

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IBrowserViewService private readonly pageService: IBrowserViewService,
		@IEditorPart private readonly editorPart: IEditorPart,
		@ICommandService private readonly commands: ICommandService,
		@IBrowserAutoReloadService private readonly autoReload: IBrowserAutoReloadService,
		@IThemeService private readonly browserThemes: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(BrowserViewEditorId, browserThemes, storageService);
		this.chatIntegration = this._register(instantiation.createInstance(BrowserEditorChatIntegration));
		this.history = this._register(instantiation.createInstance(BrowserHistoryFeature, (error: unknown) => this.report(error)));
		this.zoom = this._register(instantiation.createInstance(BrowserEditorZoomSupport, (error: unknown) => this.report(error)));
		this.emulation = this._register(instantiation.createInstance(BrowserEditorEmulationSupport));
		this.favorites = this._register(instantiation.createInstance(BrowserFavoritesFeature, () => this.setPageActions(), (error: unknown) => this.report(error)));
		this._register(this.autoReload.onDidChangeState(() => this.setPageActions()));
		this.permissions = this._register(instantiation.createInstance(BrowserPermissionsFeature, (message: string) => { this.statusDomNode.textContent = message; }, (error: unknown) => this.report(error)));
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
		const editor = this;
		this.navigation = this._register(this.instantiation.createInstance(BrowserNavigationFeatures, {
			get input() { return editor.currentInput; },
			ensureBrowserFocus: () => { if (this.visible) { this.pageHost.tryFocus(); } },
		}, toolbar, (error: unknown) => this.report(error)));
		this.addressDomNode = this.navigation.address.inputElement;
		this.navigation.address.mountContributions([this.history, this.favorites]);
		this.remoteIndicator = this._register(new BrowserRemoteIndicatorContribution(toolbar));
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
		this.renderer = this._register(this.instantiation.createInstance(WebContentsViewRendererFeature, document.defaultView!));
		this.pageHost = this.renderer.host;
		this.pageHost.onContainerCreated(this.viewportDomNode);
		this.welcome = this._register(new BrowserWelcomeFeature(this.viewportDomNode));
		this.pageStatus = this._register(new BrowserEditorErrorFeatures(this.statusDomNode, this.downloadDomNode));
		this.domNode.append(toolbar, this.statusDomNode, this.downloadDomNode, this.viewportDomNode); container.append(this.domNode);
		super.create(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener<KeyboardEvent>(this.domNode, 'keydown', event => {
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
		this._register(addDisposableListener(this.domNode, 'focusin', () => this.renderer.setVisible(this.visible)));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!(input instanceof BrowserEditorInput)) { throw new TypeError('Expected browser editor input'); }
		const model = await input.resolve();
		signal.throwIfAborted();
		this.modelListeners.clear();

		this.currentInput = input;
		this.model = model;
		this.history.setModel(model);
		this.zoom.setModel(model);
		this.emulation.setModel(model);
		this.favorites.setModel(model);
		this.remoteIndicator.update(model);
		this.permissions.setModel(model);
		await this.configurePreload(model);
		signal.throwIfAborted();
		this.findFeature.setModel(model);
		this.chatIntegration.setModel(model, message => { if (this.model === model && !this.isDisposed) { this.statusDomNode.textContent = message; } });
		this.navigation.update(model.state);
		this.renderer.setModel(model);
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
			this.pageStatus.accept(event);
		}));
		this.render(model.state);
		this.pageHost.layout();
	}
	public override clearInput(): void {
		this.chatIntegration.setModel(undefined, () => { });
		this.findFeature.setModel(undefined);

		this.visible = false;
		this.renderer.setVisible(false);
		this.renderer.setModel(undefined);
		this.welcome.update(undefined);
		this.modelListeners.clear();
		this.model = undefined;
		this.actionsUrl = undefined;
		this.currentInput = undefined;
		this.history.setModel(undefined);
		this.zoom.setModel(undefined);
		this.emulation.setModel(undefined);
		this.favorites.setModel(undefined);
		this.remoteIndicator.update(undefined);
		this.permissions.setModel(undefined);
		this.navigation.address.clear();
		this.statusDomNode.textContent = '';
		this.downloadDomNode.hidden = true;
		this.navigation.update();
		this.setPageActions();
	}
	public addConsoleLogsToChat(): Promise<void> { return this.chatIntegration.addConsoleLogsToChat(); }
	public addScreenshotToChat(fullPage: boolean): Promise<void> { return this.chatIntegration.addScreenshotToChat(fullPage); }
	public managePermissions(): Promise<void> { return this.permissions.manage(); }
	public showHistory(): Promise<void> { return this.history.show(); }
	public toggleFavorite(): void { this.favorites.toggle(); }
	public showDeviceEmulation(): Promise<void> { return this.emulation.show(); }
	public showFind(): Promise<void> { return this.findFeature.show(); }
	public hideFind(): Promise<void> { return this.findFeature.hide(); }
	public findNext(forward: boolean): Promise<void> { return this.findFeature.next(forward); }
	public override layout(_dimension: IDimension): void { this.pageHost.layout(); }
	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility); this.visible = visibility; this.renderer.setVisible(visibility);
	}
	public override focus(): void {
		this.navigation.focusUrlInput();
		if (this.configuration.getValue<boolean>('accessibility.verbosity.browser')) {
			this.statusDomNode.textContent = localize({ bundle: 'ash.workbench', key: 'browser.focusHelp' }, 'Enter a URL and press Enter. Press Alt+F1 for browser help.');
		}
	}
	private target(): IBrowserViewModel {
		if (!this.model) { throw new Error('Browser page is closed'); }
		return this.model;
	}
	private setPageActions(): void {
		if (!this.sharingToolbar) { return; }
		this.actionsUrl = this.model?.state.url;
		const go = localize({ bundle: 'ash.workbench', key: 'browser.go' }, 'Go');
		const help = localize({ bundle: 'ash.workbench', key: 'browser.help' }, 'Help');
		this.sharingToolbar.setActions([
			{ id: 'browser.go', label: go, tooltip: go, icon: Lxicon.arrowRight, enabled: true, run: () => this.navigation.navigate().catch(error => this.report(error)) },
			{ id: 'browser.help', label: help, tooltip: help, icon: Lxicon.question, enabled: true, run: () => this.showHelp().catch(error => this.report(error)) },
		], [
			...this.favorites.getActions(),
			{ id: 'browser.autoReload', label: localize({ bundle: 'ash.workbench', key: 'browser.autoReload' }, 'Toggle auto reload'), enabled: !!this.model && this.autoReload.canReload(this.model.id), checked: !!this.model && this.autoReload.isEnabled(this.model.id), tooltip: '', run: () => { if (this.model) { this.autoReload.toggle(this.model.id); } } },
			{ id: 'browser.zoom', label: localize({ bundle: 'ash.workbench', key: 'browser.zoom' }, 'Page zoom'), enabled: !!this.model && this.model.state.url !== 'about:blank', tooltip: '', run: () => this.zoom.show().catch(error => this.report(error)) },
			{ id: 'browser.emulation', label: localize({ bundle: 'ash.workbench', key: 'browser.emulation' }, 'Device emulation'), enabled: !!this.model, tooltip: '', run: () => this.emulation.show().catch(error => this.report(error)) },
			{ id: 'browser.devTools', label: localize({ bundle: 'ash.workbench', key: 'browser.devToolsAction' }, 'Developer Tools'), enabled: !!this.model, tooltip: '', run: () => this.commands.executeCommand('workbench.action.browser.toggleDevTools').catch(error => this.report(error)) },
			{ id: 'browser.clearStorage', label: localize({ bundle: 'ash.workbench', key: 'browser.clearStorage' }, 'Clear data'), enabled: !!this.model, tooltip: '', run: () => this.commands.executeCommand(`workbench.action.browser.clear${this.model!.info.session.scope[0]!.toUpperCase() + this.model!.info.session.scope.slice(1)}Storage`).catch(error => this.report(error)) },
			{ id: 'browser.find', label: localize({ bundle: 'ash.workbench', key: 'browser.find' }, 'Find in Page'), enabled: !!this.model, tooltip: '', run: () => this.findFeature.show().catch(error => this.report(error)) },
			{ id: 'browser.selectElement', label: localize({ bundle: 'ash.workbench', key: 'browser.selectElement' }, 'Select Element for Chat'), enabled: !!this.model, tooltip: '', run: () => this.target().toggleElementSelection(true, { highlightFocusedElement: true }).catch(error => this.report(error)) },
			{ id: 'browser.commentElement', label: localize({ bundle: 'ash.workbench', key: 'browser.commentElement' }, 'Comment on Elements'), enabled: !!this.model, tooltip: '', run: () => this.target().toggleElementSelection(true, { continuous: true, mode: BrowserElementSelectionMode.Comment, highlightFocusedElement: true }).catch(error => this.report(error)) },
			{ id: 'browser.selectArea', label: localize({ bundle: 'ash.workbench', key: 'browser.selectArea' }, 'Select Area for Chat'), enabled: !!this.model, tooltip: '', run: () => this.target().toggleAreaSelection(true).catch(error => this.report(error)) },
			...this.permissions.getActions(),
			{ id: 'browser.history', label: localize({ bundle: 'ash.workbench', key: 'browser.history' }, 'History'), enabled: this.model?.info.session.scope === BrowserViewStorageScope.Workspace || this.model?.info.session.scope === BrowserViewStorageScope.Global, tooltip: '', run: () => this.history.show().catch(error => this.report(error)) },
		]);
	}

	private render(state: IBrowserViewState): void {
		if (this.actionsUrl !== state.url) { this.setPageActions(); }
		this.navigation.update(state);
		this.pageStatus.render(state);
		this.welcome.update(state);
	}
	private report(error: unknown): void { if (!this.isDisposed) { this.statusDomNode.textContent = error instanceof Error && error.message === 'BrowserScreenshotTooLarge' ? localize({ bundle: 'ash.workbench', key: 'browser.screenshotTooLarge' }, 'The full page exceeds the screenshot size limit.') : error instanceof Error && error.message === 'BrowserScreenshotUnavailable' ? localize({ bundle: 'ash.workbench', key: 'browser.screenshotUnavailable' }, 'The page could not be captured.') : error instanceof Error ? error.message : String(error); } }
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
		return localize({ bundle: 'ash.workbench', key: 'browser.accessibilityHelp' }, 'Use Tab to move through browser controls. Enter in the address field navigates and focuses the webpage. Ctrl+Shift+P (Command+Shift+P on macOS) opens the Command Palette from the webpage. Ctrl+L (Command+L on macOS) or F6 in the webpage returns to the address field. Back and Forward navigate page history. Close the editor tab to close its webpage. Set workbench.externalUriOpeners to ash.browser.open for websites you want to open here. Webpages use the browser’s accessibility tree. The More Actions menu contains sharing, website permission reset, download cancellation and History. History lists visits in this storage session; type to search, use Up and Down to choose a page and Enter to open it. Clear browsing history removes this session’s recorded visits. Isolated Agent pages and ephemeral sessions do not record history. Share with Agent allows a chosen conversation to observe this page. Agent input and navigation require an isolated Agent page. Revoke all access ends that grant. Website permission dialogs name the requesting site. Reset all website permissions removes its decisions. Downloads ask for a save location; Cancel downloads stops active transfers. Use Ctrl+F to find the selected text in the page and F3 or Shift+F3 to move between matches. More Actions also offers Select Element for Chat, Comment on Elements and Select Area for Chat. Use Tab and arrow keys to choose an element, Enter to select, and Escape to cancel. Area selection supports arrow keys and Enter. Comments support keyboard editing and removal. Captured selections remain private until you explicitly choose Browser selections in Chat’s Add Context menu.') + '\n' + localize({ bundle: 'ash.workbench', key: 'browser.extendedHelp' }, 'More Actions offers Page zoom, Device emulation, Developer Tools, Favorites and browser storage clearing. Use the keyboard to choose zoom levels and device presets in the picker; Escape cancels. Favorites are added explicitly from user pages. Clearing browser data requires confirmation and applies to all pages sharing the active storage session. Local file pages reload on disk changes by default. Local HTTP previews can opt in to reload on workspace file changes. Auto reload continues in background tabs. Use Browser: Zoom In, Zoom Out and Reset Zoom to change page zoom. Default page zoom can follow window zoom; per-site overrides take precedence. Browser: Quick Open Browser Tab lists pages for the active session. Address bar search is disabled by default; choose a search engine in Settings to enable it.') + '\n' + localize({ bundle: 'ash.workbench', key: 'browser.auditHelp' }, 'Press Down in the address field to choose History or Favorites suggestions. Escape restores the page address. Browser commands provide Back, Forward, Reload, Reload Without Cache, Open File and Close Browser Tabs. Manage Website Permissions changes the current site’s location, camera, microphone, notifications or clipboard decision. Captured console logs and page screenshots stay private until attached from Browser selections in Chat. Browser data storage and localhost link settings apply to new pages and link opening.');
	}

	private showHelp(): Promise<void> {
		return this.dialogService.showMessage({ severity: DialogSeverity.Info, title: localize({ bundle: 'ash.workbench', key: 'browser.accessibilityHelpTitle' }, 'Browser accessibility help'), message: this.helpContent() });
	}
}
