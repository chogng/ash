import './media/editordroptarget.css';
import { DragAndDropObserver } from '../../../../base/browser/dnd.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { DndCssClasses } from '../../../../base/browser/ui/dnd/dnd.js';
import type { Direction } from '../../../../base/browser/ui/grid/grid.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { EditorGroup } from './editorGroup.js';
import type { IEditorTabDragAndDrop } from './editorTabDragAndDrop.js';

/** Owns the editor area's drop feedback and routes a dropped tab to its group. */
export class EditorDropTarget extends Disposable {
	private activeGroup: EditorGroup | undefined;
	private splitDirection: Direction | undefined;

	constructor(
		container: HTMLElement,
		private readonly findGroup: (target: Node) => EditorGroup | undefined,
		private readonly dragAndDrop: IEditorTabDragAndDrop,
	) {
		super();
		this._register(toDisposable(() => this.clearFeedback()));
		// The editor surface handles its own drops, so a tab drop must be routed before it reaches a pane.
		this._register(addDisposableListener(container, 'drop', event => this.onDrop(event), true));
		this._register(new DragAndDropObserver(container, {
			onDragOver: event => this.onDragOver(event),
			onDragLeave: () => this.clearFeedback(),
			onDragEnd: () => this.clearFeedback(),
		}));
	}

	private onDragOver(event: DragEvent): void {
		const target = event.target;
		const group = target instanceof Node ? this.findGroup(target) : undefined;
		if (!this.dragAndDrop.isDragging() || !group || this.isOverTitle(group, target)) {
			this.clearFeedback();
			return;
		}

		if (this.activeGroup !== group) {
			this.clearFeedback();
			this.activeGroup = group;
		}
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
		this.splitDirection = dropSplitDirection(event, group.domNode.getBoundingClientRect());
		if (this.splitDirection) group.domNode.dataset.editorDropDirection = this.splitDirection;
		else delete group.domNode.dataset.editorDropDirection;
		group.domNode.classList.add(DndCssClasses.DropTarget);
	}

	private onDrop(event: DragEvent): void {
		const target = event.target;
		const group = target instanceof Node ? this.findGroup(target) : undefined;
		if (!this.dragAndDrop.isDragging() || !group || this.isOverTitle(group, target)) {
			this.clearFeedback();
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		const direction = group === this.activeGroup ? this.splitDirection : undefined;
		this.clearFeedback();
		this.dragAndDrop.drop(group, undefined, 'after', direction);
	}

	private isOverTitle(group: EditorGroup, target: EventTarget | null): boolean {
		return target instanceof Node && !!group.domNode.querySelector('.ash-editor-title-control')?.contains(target);
	}

	private clearFeedback(): void {
		if (this.activeGroup) {
			delete this.activeGroup.domNode.dataset.editorDropDirection;
			this.activeGroup.domNode.classList.remove(DndCssClasses.DropTarget);
		}
		this.activeGroup = undefined;
		this.splitDirection = undefined;
	}
}

function dropSplitDirection(event: DragEvent, bounds: DOMRect): Direction | undefined {
	if (bounds.width <= 0 || bounds.height <= 0) return undefined;
	const distances = [
		{ direction: 'left' as const, distance: event.clientX - bounds.left, threshold: bounds.width * 0.25 },
		{ direction: 'right' as const, distance: bounds.right - event.clientX, threshold: bounds.width * 0.25 },
		{ direction: 'up' as const, distance: event.clientY - bounds.top, threshold: bounds.height * 0.25 },
		{ direction: 'down' as const, distance: bounds.bottom - event.clientY, threshold: bounds.height * 0.25 },
	].filter(candidate => candidate.distance >= 0 && candidate.distance <= candidate.threshold)
		.sort((left, right) => left.distance - right.distance);
	return distances[0]?.direction;
}
