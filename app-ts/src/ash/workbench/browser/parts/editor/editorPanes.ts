import { h, type IDimension } from '../../../../base/browser/dom.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IEditorPane } from './editorPane.js';
import { EditorPaneVisibility } from './editorPane.js';

/** Owns the pane hosts, active pane, and pane lifetimes within one editor group. */
export class EditorPanes extends Disposable {
	private readonly instances = this._register(new DisposableMap<EditorPaneInstance, EditorPaneInstance>());
	private activeInstance: EditorPaneInstance | undefined;
	private pendingInstance: EditorPaneInstance | undefined;

	constructor(private readonly container: HTMLElement) {
		super();
	}

	get activePane(): IEditorPane | undefined {
		return this.activeInstance?.pane;
	}

	get pendingPane(): EditorPaneInstance | undefined {
		return this.pendingInstance;
	}

	create(pane: IEditorPane): EditorPaneInstance {
		const instance = new EditorPaneInstance(this.container, pane);
		this.instances.set(instance, instance);
		try {
			pane.create(instance.domNode);
			instance.setVisible(EditorPaneVisibility.Hidden);
		} catch (error) {
			this.disposePane(instance);
			throw error;
		}
		return instance;
	}

	setPending(instance: EditorPaneInstance): void {
		this.pendingInstance = instance;
	}

	clearPending(instance: EditorPaneInstance): void {
		if (this.pendingInstance === instance) this.pendingInstance = undefined;
	}

	cancelPending(): void {
		if (this.pendingInstance) this.disposePane(this.pendingInstance);
	}

	disposePane(instance: EditorPaneInstance): void {
		this.clearPending(instance);
		if (this.activeInstance === instance) {
			this.activeInstance = undefined;
			instance.setVisible(EditorPaneVisibility.Hidden);
		}
		this.instances.deleteAndDispose(instance);
	}

	activate(instance: EditorPaneInstance, dimension: IDimension): void {
		if (this.activeInstance !== instance) {
			this.activeInstance?.setVisible(EditorPaneVisibility.Hidden);
			this.activeInstance = instance;
		}
		instance.pane.layout(dimension);
		instance.setVisible(EditorPaneVisibility.Visible);
	}

	layout(dimension: IDimension): void {
		this.activeInstance?.pane.layout(dimension);
	}

	focus(): void {
		this.activeInstance?.pane.focus();
	}
}

let editorPaneId = 0;

export class EditorPaneInstance extends Disposable {
	readonly domNode: HTMLDivElement;
	readonly signal: AbortSignal;
	readonly panelId: string;
	readonly tabId: string;

	constructor(container: HTMLElement, readonly pane: IEditorPane) {
		super();
		const ownerDocument = container.ownerDocument;
		const id = ++editorPaneId;
		this.panelId = `ash-editor-pane-${id}`;
		this.tabId = `ash-editor-tab-${id}`;
		const AbortControllerConstructor = ownerDocument.defaultView?.AbortController ?? AbortController;
		const abortController = new AbortControllerConstructor();
		this.signal = abortController.signal;
		this.domNode = h(ownerDocument, 'div');
		this.domNode.id = this.panelId;
		this.domNode.className = 'ash-editor-pane-host';
		this.domNode.setAttribute('role', 'tabpanel');
		this.domNode.setAttribute('aria-labelledby', this.tabId);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(pane);
		this._register(toDisposable(() => pane.clearInput()));
		this._register(toDisposable(() => pane.setVisible(EditorPaneVisibility.Hidden)));
		this._register(toDisposable(() => abortController.abort()));
	}

	setVisible(visibility: EditorPaneVisibility): void {
		this.domNode.hidden = visibility === EditorPaneVisibility.Hidden;
		this.pane.setVisible(visibility);
	}

	observeWorkingCopy(listener: () => void): void {
		const workingCopy = this.pane.workingCopy;
		if (!workingCopy) return;
		this._register(workingCopy.onDidChangeDirty(listener));
		this._register(workingCopy.onDidChangeExternalChange(listener));
	}
}
