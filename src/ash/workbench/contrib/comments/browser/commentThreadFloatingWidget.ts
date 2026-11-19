import { addDisposableListener } from '../../../../base/browser/dom.js';
import { ContextView, ContextViewHideReason } from '../../../../base/browser/ui/contextview/contextview.js';
import type { IRectangle } from '../../../../base/common/layout.js';
import { toDisposable, type DisposableStore } from '../../../../base/common/lifecycle.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { Position } from '../../../../editor/common/core/position.js';
import { ScrollType } from '../../../../editor/common/editorCommon.js';
import { localize } from '../../../../nls.js';
import type { ICommentThreadPresentation, ICommentThreadPresentationHost } from './commentThreadEditorWidget.js';

/** Presents the active thread over the editor, anchored to the rendered code line. */
export class ReviewFloatingWidget implements ICommentThreadPresentation {
	readonly closeLabel = localize('comments.review.closeFloating', 'Close comments');

	constructor(private readonly editor: ICodeEditor) { }

	revealLine(line: number): void {
		this.editor.revealLine(line, ScrollType.Immediate);
	}

	mount(line: number, panel: HTMLElement, resources: DisposableStore, host: ICommentThreadPresentationHost): boolean {
		const editorNode = this.editor.getDomNode();
		if (!editorNode) return false;
		this.revealLine(line);
		panel.classList.add('ash-review-floating-panel');
		panel.setAttribute('role', 'dialog');
		// Keep the editor's pointer handling from starting a code selection inside the thread.
		for (const event of ['pointerdown', 'mousedown', 'contextmenu', 'wheel'] as const) {
			resources.add(addDisposableListener(panel, event, event => event.stopPropagation()));
		}
		resources.add(toDisposable(() => {
			panel.classList.remove('ash-review-floating-panel');
			panel.removeAttribute('role');
		}));
		const view = new ContextView(this.editor.getContainerDomNode());
		const shown = view.show({
			anchor: editorNode,
			getAnchor: () => this.getLineAnchor(editorNode, line),
			content: panel,
			gap: 8,
			presentation: 'dialog',
			isTargetWithin: host.isThreadMarker,
			onHide: reason => host.dismiss(reason === ContextViewHideReason.Escape),
		});
		if (!shown) {
			view.dispose();
			return false;
		}
		resources.add(view);
		resources.add(this.editor.onDidScrollChange(() => view.layout()));
		resources.add(this.editor.onDidLayoutChange(() => view.layout()));
		resources.add(this.editor.onWillChangeModel(() => host.dismiss(false)));
		return true;
	}

	private getLineAnchor(editorNode: HTMLElement, line: number): IRectangle | undefined {
		const model = this.editor.getModel();
		if (!model || line > model.getLineCount()) return undefined;
		const position = this.editor.getScrolledVisiblePosition(new Position(line, 1));
		if (!position) return undefined;
		const bounds = editorNode.getBoundingClientRect();
		const top = Math.max(0, position.top);
		const bottom = Math.min(bounds.height, position.top + position.height);
		if (bottom <= top) return undefined;
		return {
			left: bounds.left + Math.max(this.editor.getLayoutInfo().contentLeft, position.left),
			top: bounds.top + top,
			width: 0,
			height: bottom - top,
		};
	}
}
