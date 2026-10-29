import { addDisposableListener, isHTMLElement } from '../../../../../../base/browser/dom.js';
import { onUnexpectedError } from '../../../../../../base/common/errors.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import type { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { Position } from '../../../../../common/core/position.js';
import { Range } from '../../../../../common/core/range.js';
import type { ITextModel } from '../../../../../common/model.js';

interface IEnableViewZoneCopySelectionOptions {
	readonly domNode: HTMLElement;
	readonly originalModel: ITextModel;
	readonly clipboardService: IClipboardService;
	getModelPositionAt(domNode: HTMLElement, offset: number): Position | undefined;
}

/** Copy source text, including its EOLs, only when both selection endpoints belong to deleted code. */
export function enableCopySelection(options: IEnableViewZoneCopySelectionOptions): DisposableStore {
	const store = new DisposableStore();
	store.add(
		addDisposableListener<ClipboardEvent>(options.domNode.ownerDocument, 'copy', event => {
			if (event.defaultPrevented) {
				return;
			}
			const selection = options.domNode.ownerDocument.getSelection();
			if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) {
				return;
			}
			const positionAt = (node: Node, offset: number): Position | undefined => {
				const element = isHTMLElement(node) ? node : node.parentElement;
				return element && options.domNode.contains(element) ? options.getModelPositionAt(element, offset) : undefined;
			};
			const anchor = positionAt(selection.anchorNode, selection.anchorOffset);
			const focus = positionAt(selection.focusNode, selection.focusOffset);
			if (!anchor || !focus) {
				return;
			}
			const start = Position.isBefore(anchor, focus) ? anchor : focus;
			const end = start === anchor ? focus : anchor;
			const text = options.originalModel.getValueInRange(Range.fromPositions(start, end));
			event.preventDefault();
			if (event.clipboardData) {
				event.clipboardData.setData('text/plain', text);
			} else {
				void options.clipboardService.writeText(text).catch(onUnexpectedError);
			}
		}),
	);
	return store;
}
