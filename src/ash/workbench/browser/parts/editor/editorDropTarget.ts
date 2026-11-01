import './media/editordroptarget.css';
import { DragAndDropObserver } from '../../../../base/browser/dnd.js';
import { addDisposableListener, isNode } from '../../../../base/browser/dom.js';
import { DndCssClasses } from '../../../../base/browser/ui/dnd/dnd.js';
import { Direction } from '../../../../base/browser/ui/grid/grid.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { EditorGroupView } from './editorGroupView.js';
import { isEditorTabCopyRequested, type IEditorTabDragAndDrop } from './editorTabDragAndDrop.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { EditorOpenSideBySideDirectionConfiguration } from '../../../services/editor/common/editorConfiguration.js';

/** Owns the editor area's drop feedback and routes a dropped tab to its group. */
export class EditorDropTarget extends Disposable {
	private activeGroup: EditorGroupView | undefined;
	private splitDirection: Direction | undefined;

	constructor(
		container: HTMLElement,
		private readonly findGroup: (target: Node) => EditorGroupView | undefined,
		private readonly dragAndDrop: IEditorTabDragAndDrop,
		@IConfigurationService private readonly configurationService: IConfigurationService,
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
		const group = isNode(target) ? this.findGroup(target) : undefined;
		if (!this.dragAndDrop.isDragging() || !group || this.isOverTitle(group, target)) {
			this.clearFeedback();
			return;
		}
		const operation = this.dragAndDrop.getGroupDropOperation(group, isEditorTabCopyRequested(event));
		if (!operation) {
			this.clearFeedback();
			if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
			return;
		}

		if (this.activeGroup !== group) {
			this.clearFeedback();
			this.activeGroup = group;
		}
		this.splitDirection = dropSplitDirection(event, group, operation.wholeGroup, this.configurationService.getValue(EditorOpenSideBySideDirectionConfiguration));
		if (event.dataTransfer) event.dataTransfer.dropEffect = operation.effect;
		if (this.splitDirection !== undefined) group.domNode.dataset.editorDropDirection = Direction[this.splitDirection].toLowerCase();
		else delete group.domNode.dataset.editorDropDirection;
		group.domNode.querySelector('.ash-editor-drop-overlay')?.classList.toggle(DndCssClasses.DropTarget, this.splitDirection === undefined);
	}

	private onDrop(event: DragEvent): void {
		const target = event.target;
		const group = isNode(target) ? this.findGroup(target) : undefined;
		if (!this.dragAndDrop.isDragging() || !group || this.isOverTitle(group, target)) {
			this.clearFeedback();
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		if (!this.dragAndDrop.getGroupDropOperation(group, isEditorTabCopyRequested(event))) {
			this.clearFeedback();
			this.dragAndDrop.end();
			return;
		}
		const direction = group === this.activeGroup ? this.splitDirection : undefined;
		this.clearFeedback();
		this.dragAndDrop.drop(group, undefined, 'after', direction, isEditorTabCopyRequested(event), 'content');
	}

	private isOverTitle(group: EditorGroupView, target: EventTarget | null): boolean {
		return isNode(target) && !!group.domNode.querySelector('.ash-editor-title-control')?.contains(target);
	}

	private clearFeedback(): void {
		if (this.activeGroup) {
			delete this.activeGroup.domNode.dataset.editorDropDirection;
			this.activeGroup.domNode.querySelector('.ash-editor-drop-overlay')?.classList.remove(DndCssClasses.DropTarget);
		}
		this.activeGroup = undefined;
		this.splitDirection = undefined;
	}
}

function dropSplitDirection(event: DragEvent, group: EditorGroupView, wholeGroup: boolean, preferredDirection: 'right' | 'down'): Direction | undefined {
	const bounds = group.domNode.getBoundingClientRect();
	const scale = group.domNode.offsetHeight > 0 ? bounds.height / group.domNode.offsetHeight : 1;
	const titleHeight = group.titleHeight.offset * scale;
	const height = bounds.height - titleHeight;
	if (bounds.width <= 0 || height <= 0) return undefined;
	const x = (event.clientX - bounds.left) / bounds.width;
	const y = (event.clientY - bounds.top - titleHeight) / height;
	if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;
	// The preferred split axis wins at corners and has a wider entry zone for groups.
	const vertical = preferredDirection === 'down';
	const primary = vertical ? y : x;
	const secondary = vertical ? x : y;
	const edge = wholeGroup ? 0.3 : 0.1;
	if (primary > edge && primary < 1 - edge && secondary > 0.1 && secondary < 0.9) return undefined;
	const directions = vertical ? [Direction.Up, Direction.Down, Direction.Left, Direction.Right] : [Direction.Left, Direction.Right, Direction.Up, Direction.Down];
	return primary < 1 / 3 ? directions[0] : primary > 2 / 3 ? directions[1] : directions[secondary < 0.5 ? 2 : 3];
}
