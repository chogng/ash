import type { URI } from '../../base/common/uri.js';
import { toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { CodeDataTransfers, DraggedChatReferenceIdentifier, LocalSelectionTransfer } from '../../platform/dnd/browser/dnd.js';

/** Lends a conversation identity until its native drag ends. */
export function fillChatReferenceDragData(transfer: DataTransfer, resource: URI): IDisposable {
	const reference = new DraggedChatReferenceIdentifier(resource);
	const selection = LocalSelectionTransfer.getInstance<DraggedChatReferenceIdentifier>();
	const token = DraggedChatReferenceIdentifier.prototype;
	transfer.setData(CodeDataTransfers.CHAT_REFERENCE, '');
	selection.setData([reference], token);
	return toDisposable(() => {
		if (selection.getData(token)?.[0] === reference) selection.clearData(token);
	});
}
