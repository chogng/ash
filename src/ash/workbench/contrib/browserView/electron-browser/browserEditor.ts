import { Emitter, Event } from '../../../../base/common/event.js';
import type { Constructor } from '../../../../platform/instantiation/common/descriptors.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { localize } from '../../../../nls.js';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IBrowserViewService } from '../../../../platform/browserView/common/browserView.js';
import { BrowserEditorInput } from '../common/browserEditorInput.js';
import { BrowserViewEditorId, type IBrowserViewModel } from '../common/browserView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService, DialogSeverity } from '../../../../platform/dialogs/common/dialogs.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { type IBrowserViewWindowConfiguration } from '../../../../platform/browserView/common/browserView.js';
import './media/browser.css';

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

/** A feature's model subscriptions end before another page is attached. */
export abstract class BrowserEditorContribution extends Disposable {
	constructor(protected readonly editor: BrowserEditor) {
		super();
		const lifetime = this._register(new DisposableStore());
		this._register(editor.onDidChangeModel(({ model, isNew }) => {
			lifetime.clear();
			this.onModelDetached();
			if (model) { this.onModelAttached(model, lifetime, isNew); }
		}));
	}
	protected onModelAttached(_model: IBrowserViewModel, _store: DisposableStore, _isNew: boolean): void { }
	onModelDetached(): void { }
	get widgets(): readonly IBrowserEditorWidget[] { return []; }
	onContainerCreated(_container: HTMLElement): void { }
	onPaneVisibilityChanged(_visible: boolean): void { }
	onPaneResized(_width: number): void { }
	afterContainerLayout(): void { }
	tryFocus(): boolean { return false; }
}

export const enum BrowserWidgetLocation { Toolbar = 'toolbar' }
export interface IBrowserEditorWidget {
	readonly location: BrowserWidgetLocation;
	readonly element: HTMLElement;
	readonly order: number;
}

/** Workbench controls for one Main-owned web page. */
export class BrowserEditor extends EditorPane implements IEditorPane {
	readonly id = BrowserViewEditorId;
	private domNode!: HTMLDivElement;
	private viewportDomNode!: HTMLDivElement;
	private currentInput: BrowserEditorInput | undefined;
	private currentModel: IBrowserViewModel | undefined;
	private readonly modelListeners = this._register(new DisposableStore());
	private readonly modelChanges = this._register(new Emitter<{ model: IBrowserViewModel | undefined; isNew: boolean; }>());
	readonly onDidChangeModel = this.modelChanges.event;
	private readonly statusChanges = this._register(new Emitter<string>());
	readonly onDidChangeStatus = this.statusChanges.event;
	private static readonly contributionTypes = new Set<Constructor<BrowserEditorContribution>>();
	private readonly contributions = new Map<Constructor<BrowserEditorContribution>, BrowserEditorContribution>();
	private visible = false;
	private inputRevision = 0;

	static registerContribution(ctor: Constructor<BrowserEditorContribution>): void { this.contributionTypes.add(ctor); }
	getContribution<T extends BrowserEditorContribution>(ctor: Constructor<T>): T | undefined { return this.contributions.get(ctor) as T | undefined; }
	getContributions(): Iterable<BrowserEditorContribution> { return this.contributions.values(); }
	get input(): BrowserEditorInput | undefined { return this.currentInput; }
	get model(): IBrowserViewModel | undefined { return this.currentModel; }
	get browserContainer(): HTMLElement { return this.viewportDomNode; }

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IBrowserViewService private readonly pageService: IBrowserViewService,
		@IThemeService private readonly browserThemes: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(BrowserViewEditorId, browserThemes, storageService);
		this._register(browserThemes.onDidColorThemeChange(() => {
			if (this.model) { void this.configurePreload(this.model).catch(error => this.report(error)); }
		}));

	}

	public override create(container: HTMLElement): void {
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-browser-editor';
		this.viewportDomNode = h(document, 'div');
		this.viewportDomNode.className = 'ash-browser-viewport';
		this.viewportDomNode.tabIndex = 0;
		this.viewportDomNode.setAttribute('aria-label', localize({ bundle: 'ash.workbench', key: 'browser.webpage' }, 'Webpage. Press F6 to return to the address field.'));
		this.domNode.append(this.viewportDomNode);
		container.append(this.domNode);
		super.create(this.domNode);
		for (const ctor of BrowserEditor.contributionTypes) {
			this.contributions.set(ctor, this._register(this.instantiation.createInstance(ctor, this)));
		}
		const widgets = [...this.getContributions()].flatMap(contribution => [...contribution.widgets]).sort((a, b) => a.order - b.order);
		for (const widget of widgets) {
			if (widget.location === BrowserWidgetLocation.Toolbar) { this.domNode.insertBefore(widget.element, this.viewportDomNode); }
		}
		for (const contribution of this.getContributions()) { contribution.onContainerCreated(this.viewportDomNode); }
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

	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!(input instanceof BrowserEditorInput)) { throw new TypeError('Expected browser editor input'); }
		this.clearInput();
		this.currentInput = input;
		const revision = ++this.inputRevision;
		const isNew = !input.model;
		const model = await input.resolve();
		signal.throwIfAborted();
		if (this.currentInput !== input || revision !== this.inputRevision || this.isDisposed) { return; }
		await this.configurePreload(model);
		signal.throwIfAborted();
		if (this.currentInput !== input || revision !== this.inputRevision || this.isDisposed) { return; }
		this.currentModel = model;
		this.modelChanges.fire({ model, isNew });
		this.modelListeners.add(Event.once(model.onWillDispose)(() => { if (this.model === model) { this.clearInput(); } }));
		this.layout({ width: this.domNode.clientWidth, height: this.domNode.clientHeight });
	}
	public override clearInput(): void {
		this.inputRevision++;
		this.modelListeners.clear();
		this.currentModel = undefined;
		this.currentInput = undefined;
		this.modelChanges.fire({ model: undefined, isNew: false });
	}
	public override layout(dimension: IDimension): void {
		for (const contribution of this.getContributions()) { contribution.onPaneResized(dimension.width); }
		for (const contribution of this.getContributions()) { contribution.afterContainerLayout(); }
	}
	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility);
		this.visible = visibility;
		for (const contribution of this.getContributions()) { contribution.onPaneVisibilityChanged(visibility); }
	}
	public override focus(): void {
		for (const contribution of this.getContributions()) { if (contribution.tryFocus()) { break; } }
		if (this.configuration.getValue<boolean>('accessibility.verbosity.browser')) {
			this.statusChanges.fire(localize({ bundle: 'ash.workbench', key: 'browser.focusHelp' }, 'Enter a URL and press Enter. Press Alt+F1 for browser help.'));
		}
	}
	public ensureBrowserFocus(): void { if (this.visible && this.model) { this.viewportDomNode.focus(); } }
	public setStatus(message: string): void { this.statusChanges.fire(message); }
	protected override disposeCore(): void {
		this.clearInput();
		super.disposeCore();
	}
	public report(error: unknown): void {
		if (!this.isDisposed) {
			this.statusChanges.fire(error instanceof Error && error.message === 'BrowserScreenshotTooLarge' ? localize({ bundle: 'ash.workbench', key: 'browser.screenshotTooLarge' }, 'The full page exceeds the screenshot size limit.') : error instanceof Error && error.message === 'BrowserScreenshotUnavailable' ? localize({ bundle: 'ash.workbench', key: 'browser.screenshotUnavailable' }, 'The page could not be captured.') : error instanceof Error ? error.message : String(error));
		}
	}
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
		const authenticationHelp = localize({ bundle: 'ash.workbench', key: 'browser.auth.help' }, 'HTTP and proxy authentication open a dialog with username and password fields. Use Tab to move between fields and buttons, Enter to sign in and Escape to cancel. Remembering credentials is optional and requires system encryption in a persistent browser session. Clear browser data removes saved credentials and cached authentication for that session. Isolated Agent pages do not use your saved credentials.');
		const agentControlHelp = localize({ bundle: 'ash.workbench', key: 'browser.agentControlHelp' }, 'Use Allow Agent browser tools in Settings to control browser automation. Turning it off cancels operations, closes Agent pages and revokes sharing. Advanced browser control (CDP) is off by default. It enables reviewed debugging commands on isolated Agent pages. File uploads require the task’s file permissions; direct host filesystem access is blocked.');
		const contextMenuHelp = localize({ bundle: 'ash.workbench', key: 'browser.contextHelp' }, 'Right-click the webpage, or focus it and press the Menu key or Shift+F10, to open its context menu. Text, input fields, links and images offer editing, copying, saving, opening in a new tab, navigation and zoom actions. Use arrow keys to choose, Enter to run an action, and Escape to close the menu and return to the webpage.');

		return localize('browser.passwords.pageHelp', 'Website passwords: interact with a visible same-origin login form or SPA login panel to fill a saved account. Username-first steps can continue within this page and origin for two minutes, including document changes. Submit with the website’s button or Enter; form methods and scripted submission are supported. Verification codes are never filled. When the submitted login and visible verification fields disappear, you can save or update the password; the website controls authentication, and a disappearing form does not guarantee success. Choose an account when several are saved. New-password fields, Agent and ephemeral sessions are excluded. Search, edit or delete accounts and turn saving or filling off in Settings > Workbench > Browser. Escape cancels prompts.') + '\n' + authenticationHelp + '\n' + agentControlHelp + '\n' + contextMenuHelp + '\n' + localize({ bundle: 'ash.workbench', key: 'browser.accessibilityHelp' }, 'Use Tab to move through browser controls. Enter in the address field navigates and focuses the webpage. Ctrl+Shift+P (Command+Shift+P on macOS) opens the Command Palette from the webpage. Ctrl+L (Command+L on macOS) or F6 in the webpage returns to the address field. Back and Forward navigate page history. Close the editor tab to close its webpage. Set workbench.externalUriOpeners to ash.browser.open for websites you want to open here. Webpages use the browser’s accessibility tree. The More Actions menu contains sharing, website permission reset, download cancellation and History. History lists visits in this storage session; type to search, use Up and Down to choose a page and Enter to open it. Clear browsing history removes this session’s recorded visits. Isolated Agent pages and ephemeral sessions do not record history. Share with Agent allows a chosen conversation to observe this page. Agent input and navigation require an isolated Agent page. Revoke all access ends that grant. Website permission dialogs name the requesting site. Reset all website permissions removes its decisions. Downloads ask for a save location; Cancel downloads stops active transfers. Use Ctrl+F to find the selected text in the page and F3 or Shift+F3 to move between matches. More Actions also offers Select Element for Chat, Comment on Elements and Select Area for Chat. Use Tab and arrow keys to choose an element, Enter to select, and Escape to cancel. Area selection supports arrow keys and Enter. Comments support keyboard editing and removal. Captured selections remain private until you explicitly choose Browser selections in Chat’s Add Context menu.') + '\n' + localize({ bundle: 'ash.workbench', key: 'browser.extendedHelp' }, 'More Actions offers Page zoom, Device emulation, Developer Tools, Favorites and browser storage clearing. Use the keyboard to choose zoom levels and device presets in the picker; Escape cancels. Favorites are added explicitly from user pages. Clearing browser data requires confirmation and applies to all pages sharing the active storage session. Local file pages reload on disk changes by default. Local HTTP previews can opt in to reload on workspace file changes. Auto reload continues in background tabs. Use Browser: Zoom In, Zoom Out and Reset Zoom to change page zoom. Default page zoom can follow window zoom; per-site overrides take precedence. Browser: Quick Open Browser Tab lists pages for the active session. Address bar search is disabled by default; choose a search engine in Settings to enable it.') + '\n' + localize({ bundle: 'ash.workbench', key: 'browser.auditHelp' }, 'Press Down in the address field to choose navigation, search, History or Favorites suggestions. Enter accepts the selected action. Escape restores the page address and returns to the webpage; leaving the picker keeps focus where you moved it. Browser commands provide Back, Forward, Reload, Reload Without Cache, Open File and Close Browser Tabs. The arrow beside Reload opens More Reload Actions, with Reload Without Cache and Toggle auto reload. Use Left and Right to move between Reload and its arrow, Down to open the menu, and Escape to close it and return focus. Manage Website Permissions changes the current site’s location, camera, microphone, notifications or clipboard decision. Captured console logs and page screenshots stay private until attached from Browser selections in Chat. Browser data storage and localhost link settings apply to new pages and link opening.');
	}

	public showHelp(): Promise<void> {
		return this.dialogService.showMessage({ severity: DialogSeverity.Info, title: localize({ bundle: 'ash.workbench', key: 'browser.accessibilityHelpTitle' }, 'Browser accessibility help'), message: this.helpContent() });
	}
}
