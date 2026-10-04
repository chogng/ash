import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { localize } from '../../../../nls.js';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IBrowserViewState } from '../../../../platform/browserView/common/browserView.js';
import { BrowserEditorInput } from '../common/browserEditorInput.js';
import type { IBrowserViewModel } from '../common/browserView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService, DialogSeverity } from '../../../../platform/dialogs/common/dialogs.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import { IDialogsModel } from '../../../common/dialogs.js';
import './media/browser.css';

/** Workbench controls and geometry for one Main-owned web page. */
export class BrowserEditor extends Disposable implements IEditorPane {
	static readonly ID = 'ash.editor.browser';
	readonly id = BrowserEditor.ID;
	private domNode!: HTMLDivElement;
	private addressDomNode!: HTMLInputElement;
	private viewportDomNode!: HTMLDivElement;
	private statusDomNode!: HTMLDivElement;
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

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IDialogsModel private readonly dialogs: IDialogsModel,
		@IContextMenuService menus: IContextMenuService,
	) {
		super();
		this._register(dialogs.onWillShowDialog(() => this.refreshLayout()));
		this._register(dialogs.onDidCloseDialog(() => this.refreshLayout()));
		this._register(menus.onDidShowContextMenu(() => { this.menuVisible = true; this.refreshLayout(); }));
		this._register(menus.onDidHideContextMenu(() => { this.menuVisible = false; this.refreshLayout(); }));
		this._register(toDisposable(() => {
			if (this.targetId && visiblePanes.get(this.targetId) === this) { visiblePanes.delete(this.targetId); }
		}));
	}

	create(container: HTMLElement): void {
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
		this.addressDomNode.spellcheck = false;
		toolbar.append(this.addressDomNode);
		button('Go', () => this.navigate());
		button('Help', () => this.showHelp());
		this.statusDomNode = h(document, 'div'); this.statusDomNode.className = 'ash-browser-status';
		this.statusDomNode.setAttribute('role', 'status');
		this.viewportDomNode = h(document, 'div'); this.viewportDomNode.className = 'ash-browser-viewport';
		this.viewportDomNode.tabIndex = 0;
		this.viewportDomNode.setAttribute('aria-label', 'Webpage. Press F6 to return to the address field.');
		this._register(addDisposableListener(this.viewportDomNode, 'focus', () => { this.focusOutside = false; this.refreshLayout(); void this.update.then(() => this.target().focus()).catch(error => this.report(error)); }));
		this.domNode.append(toolbar, this.statusDomNode, this.viewportDomNode); container.append(this.domNode);
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

	async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!(input instanceof BrowserEditorInput)) { throw new TypeError('Expected browser editor input'); }
		const model = await input.resolve();
		signal.throwIfAborted();
		this.modelListeners.clear();
		this.model = model;
		this.targetId = model.id;
		this.modelListeners.add(model.onDidChangeState(state => this.render(state)));
		this.modelListeners.add(model.onDidEvent(event => {
			if (event.type === 'focusAddress') { this.focus(); }
			if (event.type === 'loadFailed') { this.statusDomNode.textContent = `Unable to load page: ${event.errorDescription}`; }
			if (event.type === 'renderProcessGone') { this.statusDomNode.textContent = `Page stopped: ${event.reason}`; }
		}));
		this.render(model.state);
		this.refreshLayout();
	}
	clearInput(): void { this.visible = false; this.refreshLayout(); this.modelListeners.clear(); }
	layout(_dimension: IDimension): void { this.refreshLayout(); }
	setVisible(visibility: EditorPaneVisibility): void { this.visible = visibility === EditorPaneVisibility.Visible; this.refreshLayout(); }
	focus(): void {
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
	private render(state: IBrowserViewState): void {
		if (this.addressDomNode.ownerDocument.activeElement !== this.addressDomNode) { this.addressDomNode.value = state.url; }
		this.backDomNode.disabled = !state.canGoBack; this.forwardDomNode.disabled = !state.canGoForward;
		this.reloadDomNode.textContent = state.loading ? 'Stop' : 'Reload';
		this.statusDomNode.textContent = state.loading ? 'Loading page…' : state.title || state.url;
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
		return localize({ bundle: 'ash.workbench', key: 'browser.accessibilityHelp' }, 'Use Tab to move through browser controls. Enter in the address field navigates. Ctrl+L (Command+L on macOS) or F6 in the webpage returns to the address field. Back and Forward navigate page history. Close the editor tab to close its webpage. Set workbench.externalUriOpeners to ash.browser.open for websites you want to open here. Webpages use the browser’s accessibility tree. Downloads and website permissions are unavailable in this isolated session.');
	}

	private showHelp(): Promise<void> {
		return this.dialogService.showMessage({ severity: DialogSeverity.Info, title: 'Browser accessibility help', message: this.helpContent() });
	}
}

// A moved tab can create its new pane before the old pane is disposed.
const visiblePanes = new Map<string, BrowserEditor>();
