import { addDisposableListener, h, isNode } from '../../../../base/browser/dom.js';
import { EditorInputCapabilities, type IResourceEditorInput } from '../../../common/editor.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { LocalSelectionTransfer } from '../../../../platform/dnd/browser/dnd.js';
import type { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { DraggedEditorIdentifier, isEditorTabCopyRequested } from '../../../browser/parts/editor/editorTabDragAndDrop.js';
import type { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import type { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import type { IEditorGroupView } from '../../../browser/parts/editor/editor.js';
import { chatWindowEdges, type ChatWindowEdge } from '../common/chatWindowLayout.js';
import type { ChatWindowGrid } from './chatWindowGrid.js';
import { moveChatWindowEditors } from './chatWindowEditors.js';

export class ChatWindowPartFactory extends Disposable {
	private readonly transfer = LocalSelectionTransfer.getInstance<DraggedEditorIdentifier>();
	private readonly created = this._register(new DisposableMap<IEditorPart, DisposableStore>());
	private readonly locations = new Map<IEditorPart, ChatWindowEdge>();
	private readonly transferring = new Set<IEditorGroupView>();
	private readonly feedback: HTMLElement;

	constructor(
		private readonly grid: ChatWindowGrid,
		private readonly editors: IEditorPartsService,
		private readonly context: IContextKeyService,
		private readonly main: IEditorPart,
		private readonly accepts: (input: IResourceEditorInput) => boolean,
		private readonly canRemove: () => boolean,
		private readonly onEmpty: () => void,
		private readonly reportError: (error: unknown) => void,
	) {
		super();
		const surface = grid.element;
		this.feedback = h(surface.ownerDocument, 'div', { className: 'ash-chat-window-edge-drop' });
		this.feedback.setAttribute('aria-hidden', 'true');
		this._register(toDisposable(() => this.feedback.remove()));
		this._register(addDisposableListener(surface, 'dragover', event => {
			const edge = this.hitTest(event);
			this.showFeedback(edge);
			if (!edge) return;
			event.preventDefault();
			event.stopPropagation();
			if (event.dataTransfer) event.dataTransfer.dropEffect = this.dropCopies(event) ? 'copy' : 'move';
		}, true));
		this._register(addDisposableListener(surface, 'dragleave', event => {
			if (!isNode(event.relatedTarget) || !surface.contains(event.relatedTarget)) this.showFeedback(undefined);
		}));
		this._register(addDisposableListener(surface.ownerDocument, 'dragend', () => this.showFeedback(undefined)));
		this._register(addDisposableListener(surface, 'drop', event => {
			const edge = this.hitTest(event);
			this.showFeedback(undefined);
			const drag = edge && this.draggedEditors();
			if (!edge || !drag) return;
			event.preventDefault();
			event.stopPropagation();
			const copy = this.dropCopies(event);
			this.transfer.clearData(DraggedEditorIdentifier.prototype);
			void this.moveEditorsIntoNewPart(edge, drag.source, drag.inputs, copy).catch(this.reportError);
		}, true));
	}

	get parts(): readonly IEditorPart[] { return [...this.locations.keys()]; }

	save() {
		return this.parts.filter(part => part.groups.some(group => group.inputs.length)).map(part => ({
			edge: this.locations.get(part)!,
			size: this.grid.getEdgePartSize(part),
			editors: part.saveWorkingSet('chatWindow.edge'),
		}));
	}

	createPart(edge: ChatWindowEdge, size: number): IEditorPart {
		const lifetime = new DisposableStore();
		const container = h(this.grid.element.ownerDocument, 'div');
		const part = this.editors.createEditorPart(container, {
			contextKeyService: this.context,
			modalContainer: this.grid.element.parentElement!,
			headerRowHeight: undefined,
			supportsGroupSplitting: true,
			canDropEditor: this.accepts,
		});
		this.created.set(part, lifetime);
		this.locations.set(part, edge);
		part.domNode.dataset.chatWindowEdge = edge;
		lifetime.add(this.editors.registerWindowEditorPart(part, () => part));
		lifetime.add(toDisposable(() => part.dispose()));
		lifetime.add(toDisposable(() => this.locations.delete(part)));
		this.grid.addEdgePart(part, edge, size);
		lifetime.add(part.onDidChangeEditors(event => {
			if (event.kind === 'groupChanged' && event.event.kind === 'editorClosed') {
				queueMicrotask(() => this.removeIfEmpty(part));
			}
		}));
		return part;
	}

	removeIfEmpty(part: IEditorPart): void {
		if (this.isDisposed || !this.canRemove() || !this.locations.has(part)
			|| part.groups.some(group => group.inputs.length || this.transferring.has(group))) return;
		const focused = part.domNode.contains(part.domNode.ownerDocument.activeElement);
		this.grid.removeEdgePart(part);
		this.created.deleteAndDispose(part);
		if (focused) this.main.focus();
		this.onEmpty();
	}

	async moveEditorsIntoNewPart(edge: ChatWindowEdge, source: IEditorGroupView, inputs: readonly IResourceEditorInput[], copy = false): Promise<void> {
		if (this.isDisposed || this.transferring.has(source) || !inputs.length || !inputs.every(input => source.inputs.includes(input) && this.accepts(input))) return;
		const width = edge === 'left' || edge === 'right';
		const part = this.createPart(edge, (width ? this.grid.element.clientWidth : this.grid.element.clientHeight) / 3);
		const target = part.activeGroup;
		const sourcePart = this.parts.find(candidate => candidate.groups.includes(source));
		this.transferring.add(source);
		try {
			if (copy) {
				for (const input of inputs) {
					const preferredEditorId = source.editors.find(editor => editor.input === input)?.paneId;
					await target.openEditor(input.copy?.() ?? input, { pinned: true, preferredEditorId });
					target.restoreEditorViewState(input, source.saveEditorViewState(input));
				}
			} else {
				await moveChatWindowEditors(inputs.map(input => ({ group: source, input, target })));
			}
			target.focus();
		} finally {
			this.transferring.delete(source);
			this.removeIfEmpty(part);
			if (sourcePart) this.removeIfEmpty(sourcePart);
		}
	}

	canMoveFrom(group: IEditorGroupView): boolean {
		return !!group.activeInput && this.accepts(group.activeInput) && this.grid.element.contains(group.domNode);
	}

	private draggedEditors() {
		const data = this.transfer.getData(DraggedEditorIdentifier.prototype);
		const source = data?.[0]?.source;
		if (!source || !data?.length) return undefined;
		const selected = new Set(data.filter(item => item.source === source).map(item => item.input));
		const inputs = data[0]!.wholeGroup ? source.inputs : source.inputs.filter(input => selected.has(input));
		return inputs.length && inputs.every(this.accepts) ? { source, inputs } : undefined;
	}

	private dropCopies(event: DragEvent): boolean {
		return isEditorTabCopyRequested(event) && !!this.draggedEditors()?.inputs.every(input => !((input.capabilities ?? 0) & EditorInputCapabilities.Singleton));
	}

	private hitTest(event: DragEvent): ChatWindowEdge | undefined {
		if (!this.draggedEditors()) return undefined;
		const { left, right, top, bottom } = this.grid.element.getBoundingClientRect();
		const distances = { left: event.clientX - left, right: right - event.clientX, top: event.clientY - top, bottom: bottom - event.clientY };
		const distance = Math.min(...Object.values(distances));
		return distance >= 0 && distance <= 24 ? chatWindowEdges.find(edge => distances[edge] === distance) : undefined;
	}

	private showFeedback(edge: ChatWindowEdge | undefined): void {
		if (!edge) {
			this.feedback.remove();
			return;
		}
		this.feedback.dataset.edge = edge;
		if (!this.feedback.isConnected) this.grid.element.append(this.feedback);
	}
}
