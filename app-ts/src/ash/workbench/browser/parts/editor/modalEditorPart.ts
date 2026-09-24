import './media/modalEditorPart.css';
import { addDisposableListener, h, isHTMLElement, stopEvent } from '../../../../base/browser/dom.js';
import { focusFirst, restoreFocus, trapTabFocus } from '../../../../base/browser/focus.js';
import { Dimension, type IDimension } from '../../../../base/browser/dom.js';
import { observeElementSize } from '../../../../base/browser/observer.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { DisposableMap, Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { lxiconsLibrary } from '../../../../base/common/lxiconsLibrary.js';
import type { EditorInput, EditorOpenOptions } from '../../../services/editor/common/editorService.js';
import { EditorOpenSupersededError } from './editorGroup.js';
import { type EditorPaneCreationOptions, type IEditorPane, EditorPaneVisibility } from './editorPane.js';
import { EditorPaneRegistry } from './editorRegistry.js';
import { editorInputKey } from './editorTabsControl.js';

export interface ModalEditorPartOptions {
	readonly container: HTMLElement;
	readonly registry: EditorPaneRegistry;
	readonly paneCreationOptions: Omit<EditorPaneCreationOptions, 'input'>;
}

interface ModalEditorEntry {
	readonly input: EditorInput;
	readonly instance: ModalEditorPaneInstance;
}

let nextModalEditorId = 1;

/** Owns the single Editor Pane presented above the Workbench. */
export class ModalEditorPart extends Disposable {
	public readonly domNode: HTMLElement;
	public readonly onDidRequestClose: Event<EditorInput>;

	private readonly active = this._register(new MutableDisposable<ModalEditorPaneInstance>());
	private readonly closeButton: Button;
	private readonly contentDomNode: HTMLDivElement;
	private readonly hostDomNode: HTMLDivElement;
	private readonly pending = this._register(new DisposableMap<number, ModalEditorPaneInstance>());
	private readonly requestCloseEmitter = this._register(new Emitter<EditorInput>());
	private readonly titleDomNode: HTMLHeadingElement;
	private currentEntry: ModalEditorEntry | undefined;
	private dimension: IDimension = Dimension.Zero;
	private focusToRestore: HTMLElement | undefined;
	private openSequence = 0;
	private visible = false;

	constructor(private readonly options: ModalEditorPartOptions) {
		super();
		const ownerDocument = options.container.ownerDocument;
		this.hostDomNode = h(ownerDocument, 'div');
		this.hostDomNode.className = 'ash-modal-editor-host';
		this.hostDomNode.hidden = true;

		this.domNode = h(ownerDocument, 'section');
		this.domNode.className = 'ash-modal-editor';
		this.domNode.tabIndex = -1;
		this.domNode.setAttribute('role', 'dialog');
		this.domNode.setAttribute('aria-modal', 'true');

		const headerDomNode = h(ownerDocument, 'header');
		headerDomNode.className = 'ash-modal-editor-header';
		this.titleDomNode = h(ownerDocument, 'h2');
		this.titleDomNode.className = 'ash-modal-editor-title';
		this.titleDomNode.id = `ash-modal-editor-title-${nextModalEditorId++}`;
		this.domNode.setAttribute('aria-labelledby', this.titleDomNode.id);
		this.closeButton = this._register(new Button(headerDomNode, {
			label: 'Close editor',
			icon: lxiconsLibrary.close,
			onClick: () => this.requestClose(),
		}));
		this.closeButton.toggleClassName('ash-modal-editor-close', true);
		headerDomNode.append(this.titleDomNode, this.closeButton.domNode);

		this.contentDomNode = h(ownerDocument, 'div');
		this.contentDomNode.className = 'ash-modal-editor-content';
		this.domNode.append(headerDomNode, this.contentDomNode);
		this.hostDomNode.append(this.domNode);
		options.container.append(this.hostDomNode);

		this.onDidRequestClose = this.requestCloseEmitter.event;
		this._register(observeElementSize(this.contentDomNode, size => this.layout(size)));
		this._register(trapTabFocus(this.domNode));
		this._register(addDisposableListener(this.hostDomNode, 'mousedown', event => {
			if (event.target !== this.hostDomNode) return;
			stopEvent(event);
			this.requestClose();
		}));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.defaultPrevented || event.isComposing || event.key !== 'Escape') return;
			stopEvent(event);
			this.requestClose();
		}));
		this._register(toDisposable(() => {
			this.hide();
			this.hostDomNode.remove();
		}));
	}

	public get activeInput(): EditorInput | undefined {
		return this.currentEntry?.input;
	}

	public get activePane(): IEditorPane | undefined {
		return this.active.value?.pane;
	}

	public get isVisible(): boolean {
		return this.visible;
	}

	public async openEditor(input: EditorInput, openOptions: EditorOpenOptions = {}): Promise<IEditorPane> {
		const descriptor = this.options.registry.resolve(input, openOptions);
		if (this.currentEntry && editorInputKey(this.currentEntry.input) === editorInputKey(input) && this.currentEntry.instance.pane.id === descriptor.id) {
			this.currentEntry = { input, instance: this.currentEntry.instance };
			this.updateTitle(input);
			this.show(openOptions.preserveFocus === true);
			return this.currentEntry.instance.pane;
		}

		const sequence = ++this.openSequence;
		this.cancelPendingOpen();
		const pane = descriptor.create({ ...this.options.paneCreationOptions, input });
		if (pane.id !== descriptor.id) {
			pane.dispose();
			throw new TypeError(`Editor pane factory '${descriptor.id}' created '${pane.id}'`);
		}
		const instance = new ModalEditorPaneInstance(this.contentDomNode, pane);
		this.pending.set(sequence, instance);
		try {
			pane.create(instance.domNode);
			instance.setVisible(EditorPaneVisibility.Hidden);
			await pane.setInput(input, instance.signal);
		} catch (error) {
			this.pending.deleteAndDispose(sequence);
			if (sequence !== this.openSequence) throw new EditorOpenSupersededError(input);
			throw error;
		}
		if (sequence !== this.openSequence) {
			this.pending.deleteAndDispose(sequence);
			throw new EditorOpenSupersededError(input);
		}
		const committed = this.pending.deleteAndLeak(sequence);
		if (!committed) throw new EditorOpenSupersededError(input);
		this.active.value?.setVisible(EditorPaneVisibility.Hidden);
		this.active.value = committed;
		this.currentEntry = { input, instance: committed };
		this.contentDomNode.replaceChildren(committed.domNode);
		this.updateTitle(input);
		this.show(openOptions.preserveFocus === true);
		return pane;
	}

	public closeEditor(input: EditorInput): boolean {
		if (!this.currentEntry || editorInputKey(this.currentEntry.input) !== editorInputKey(input)) return false;
		this.openSequence += 1;
		this.cancelPendingOpen();
		this.hide();
		this.currentEntry = undefined;
		this.active.clear();
		this.contentDomNode.replaceChildren();
		this.titleDomNode.textContent = '';
		return true;
	}

	public focus(): void {
		if (!this.visible) return;
		this.focusEditorContent();
	}

	private cancelPendingOpen(): void {
		for (const [sequence] of this.pending) this.pending.deleteAndDispose(sequence);
	}

	private focusEditorContent(): void {
		this.activePane?.focus();
		if (this.domNode.contains(this.domNode.ownerDocument.activeElement)) return;
		if (!focusFirst(this.domNode)) this.domNode.focus();
	}

	private hide(): void {
		if (!this.visible) return;
		this.visible = false;
		this.active.value?.setVisible(EditorPaneVisibility.Hidden);
		this.hostDomNode.hidden = true;
		const focusToRestore = this.focusToRestore;
		this.focusToRestore = undefined;
		if (focusToRestore) restoreFocus(focusToRestore);
	}

	private layout(dimension: IDimension): void {
		this.dimension = new Dimension(dimension.width, dimension.height);
		this.activePane?.layout(this.dimension);
	}

	private requestClose(): void {
		const input = this.activeInput;
		if (input) this.requestCloseEmitter.fire(input);
	}

	private show(preserveFocus: boolean): void {
		if (!this.visible) {
			const activeElement = this.domNode.ownerDocument.activeElement;
			this.focusToRestore = isHTMLElement(activeElement) ? activeElement : undefined;
			this.visible = true;
			this.hostDomNode.hidden = false;
			this.active.value?.setVisible(EditorPaneVisibility.Visible);
			this.activePane?.layout(this.dimension);
		}
		if (!preserveFocus) this.focusEditorContent();
	}

	private updateTitle(input: EditorInput): void {
		const title = editorInputLabel(input);
		this.titleDomNode.textContent = title;
		const closeLabel = `Close ${title}`;
		this.closeButton.label = closeLabel;
		this.closeButton.setTitle(closeLabel);
		this.closeButton.domNode.setAttribute('aria-label', closeLabel);
	}
}

class ModalEditorPaneInstance extends Disposable {
	public readonly domNode: HTMLDivElement;
	public readonly signal: AbortSignal;

	constructor(container: HTMLElement, public readonly pane: IEditorPane) {
		super();
		const ownerDocument = container.ownerDocument;
		const AbortControllerConstructor = ownerDocument.defaultView?.AbortController ?? AbortController;
		const abortController = new AbortControllerConstructor();
		this.signal = abortController.signal;
		this.domNode = h(ownerDocument, 'div');
		this.domNode.className = 'ash-modal-editor-pane-host';
		this.domNode.hidden = true;
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(pane);
		this._register(toDisposable(() => pane.clearInput()));
		this._register(toDisposable(() => pane.setVisible(EditorPaneVisibility.Hidden)));
		this._register(toDisposable(() => abortController.abort()));
	}

	public setVisible(visibility: EditorPaneVisibility): void {
		this.domNode.hidden = visibility === EditorPaneVisibility.Hidden;
		this.pane.setVisible(visibility);
	}
}

function editorInputLabel(input: Pick<EditorInput, 'resource' | 'label'>): string {
	if (input.label?.trim()) return input.label;
	const path = decodeURIComponent(input.resource.path).replace(/\/+$/u, '');
	const separator = path.lastIndexOf('/');
	return path.slice(separator + 1) || input.resource.toString();
}
