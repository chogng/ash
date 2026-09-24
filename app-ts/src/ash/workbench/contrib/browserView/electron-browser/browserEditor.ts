import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IBrowserViewApi, type IBrowserViewState } from '../../../../platform/browser/common/browserView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService, DialogSeverity } from '../../../../platform/dialogs/common/dialogs.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import { IDialogsModel } from '../../../common/dialogs.js';
import './media/browserEditor.css';

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
	private state: IBrowserViewState | undefined;
	private targetId: string | undefined;
	private visible = false;
	private menuVisible = false;
	private focusOutside = false;
	private update: Promise<void> = Promise.resolve();

	constructor(
		@IBrowserViewApi private readonly api: IBrowserViewApi,
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
		const subscription = api.onDidEvent(event => {
			if (event.type === 'stateChanged' && event.state.targetId === this.targetId) { this.render(event.state); }
			if ('targetId' in event && event.targetId === this.targetId) {
				if (event.type === 'focusAddress') { this.focus(); }
				if (event.type === 'closed') { this.targetId = undefined; this.statusDomNode.textContent = 'Page closed'; }
				if (event.type === 'loadFailed') { this.statusDomNode.textContent = `Unable to load page: ${event.errorDescription}`; }
				if (event.type === 'renderProcessGone') { this.statusDomNode.textContent = `Page stopped: ${event.reason}`; }
				if (event.type === 'openRequested') { void api.create({ url: event.url }).catch(error => this.report(error)); }
			}
		});
		this._register(toDisposable(() => subscription.dispose()));
		this._register(toDisposable(() => {
			const targetId = this.targetId;
			this.targetId = undefined;
			if (targetId) { void this.update.then(() => api.close({ targetId })).catch(error => console.error('Browser close failed', error)); }
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
		this.backDomNode = button('Back', () => this.api.goBack(this.target()));
		this.forwardDomNode = button('Forward', () => this.api.goForward(this.target()));
		this.reloadDomNode = button('Reload', () => this.state?.loading ? this.api.stop(this.target()) : this.api.reload(this.target()));
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
		this._register(addDisposableListener(this.viewportDomNode, 'focus', () => { this.focusOutside = false; this.refreshLayout(); void this.update.then(() => this.api.focus(this.target())).catch(error => this.report(error)); }));
		this.domNode.append(toolbar, this.statusDomNode, this.viewportDomNode); container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener<KeyboardEvent>(this.domNode, 'keydown', event => {
			if (event.key === 'Enter' && event.target === this.addressDomNode) { event.preventDefault(); void this.navigate().catch(error => this.report(error)); }
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') { event.preventDefault(); this.focus(); }
			if (event.altKey && event.key === 'F1') { event.preventDefault(); void this.showHelp(); }
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
		const targetId = input.resource.path.slice(1);
		const state = await this.api.getState({ targetId });
		signal.throwIfAborted();
		this.targetId = targetId; this.render(state); this.refreshLayout();
	}
	clearInput(): void { this.visible = false; this.refreshLayout(); }
	layout(_dimension: IDimension): void { this.refreshLayout(); }
	setVisible(visibility: EditorPaneVisibility): void { this.visible = visibility === EditorPaneVisibility.Visible; this.refreshLayout(); }
	focus(): void {
		this.addressDomNode.focus(); this.addressDomNode.select();
		if (this.configuration.getValue<boolean>('accessibility.verbosity.browser')) {
			this.statusDomNode.textContent = 'Enter a URL and press Enter. Press Alt+F1 for browser help.';
		}
	}
	private target(): { targetId: string } {
		if (!this.targetId) { throw new Error('Browser page is closed'); }
		return { targetId: this.targetId };
	}
	private navigate(): Promise<void> { return this.api.navigate({ ...this.target(), url: this.addressDomNode.value.trim() }); }
	private render(state: IBrowserViewState): void {
		this.state = state;
		if (this.addressDomNode.ownerDocument.activeElement !== this.addressDomNode) { this.addressDomNode.value = state.url; }
		this.backDomNode.disabled = !state.canGoBack; this.forwardDomNode.disabled = !state.canGoForward;
		this.reloadDomNode.textContent = state.loading ? 'Stop' : 'Reload';
		this.statusDomNode.textContent = state.loading ? 'Loading page…' : state.title || state.url;
	}
	private refreshLayout(): void {
		if (!this.targetId || !this.viewportDomNode || this.isDisposed) { return; }
		const targetId = this.targetId;
		this.update = this.update.then(async () => {
			if (this.targetId !== targetId || this.isDisposed) { return; }
			const bounds = this.viewportDomNode.getBoundingClientRect();
			const visible = this.visible && !this.menuVisible && !this.focusOutside && this.dialogs.dialogs.length === 0 && bounds.width > 0 && bounds.height > 0;
			if (visible) {
				await this.api.layout({ targetId, bounds: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) } });
			}
			await this.api.setVisibility({ targetId, visible });
		}).catch(error => this.report(error));
	}
	private report(error: unknown): void { if (!this.isDisposed) { this.statusDomNode.textContent = error instanceof Error ? error.message : String(error); } }
	private showHelp(): Promise<void> {
		return this.dialogService.showMessage({ severity: DialogSeverity.Info, title: 'Browser accessibility help', message: 'Use Tab to move through browser controls. Enter in the address field navigates. Ctrl+L (Command+L on macOS) or F6 in the webpage returns to the address field. Back and Forward navigate page history. Close the editor tab to close its webpage.', detail: 'Webpages use the browser’s accessibility tree. Downloads and website permissions are unavailable in this isolated session.' });
	}
}
