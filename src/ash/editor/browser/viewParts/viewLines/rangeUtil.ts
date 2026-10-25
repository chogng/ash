import { Constants } from '../../../../base/common/uint.js';
import { FloatHorizontalRange } from '../../view/renderingContext.js';
import { DomReadingContext } from './domReadingContext.js';

export class RangeUtil {

	/**
	 * Reusing the same range here
	 * because IE is buggy and constantly freezes when using a large number
	 * of ranges and calling .detach on them
	 */
	private static readonly _handyReadyRanges = new WeakMap<Document, Range>();

	private static _createRange(ownerDocument: Document): Range {
		let range = this._handyReadyRanges.get(ownerDocument);
		if (!range) {
			range = ownerDocument.createRange();
			this._handyReadyRanges.set(ownerDocument, range);
		}
		return range;
	}

	private static _detachRange(range: Range, endNode: HTMLElement): void {
		// Move range out of the span node, IE doesn't like having many ranges in
		// the same spot and will act badly for lines containing dashes ('-')
		range.selectNodeContents(endNode);
	}

	private static _readClientRects(startElement: Node, startOffset: number, endElement: Node, endOffset: number, endNode: HTMLElement): DOMRectList | null {
		const range = this._createRange(endNode.ownerDocument);
		try {
			range.setStart(startElement, startOffset);
			range.setEnd(endElement, endOffset);

			return range.getClientRects();
		} catch (e) {
			// This is life ...
			return null;
		} finally {
			this._detachRange(range, endNode);
		}
	}

	private static _mergeAdjacentRanges(ranges: FloatHorizontalRange[]): FloatHorizontalRange[] {
		if (ranges.length === 1) {
			// There is nothing to merge
			return ranges;
		}

		ranges.sort(FloatHorizontalRange.compare);

		const result: FloatHorizontalRange[] = [];
		let resultLen = 0;
		let prev = ranges[0];

		for (let i = 1, len = ranges.length; i < len; i++) {
			const range = ranges[i];
			if (prev.left + prev.width + 0.9 /* account for browser's rounding errors*/ >= range.left) {
				prev.width = Math.max(prev.width, range.left + range.width - prev.left);
			} else {
				result[resultLen++] = prev;
				prev = range;
			}
		}

		result[resultLen++] = prev;

		return result;
	}

	private static _createHorizontalRangesFromClientRects(clientRects: DOMRectList | null, clientRectDeltaLeft: number, clientRectScale: number): FloatHorizontalRange[] | null {
		if (!clientRects || clientRects.length === 0) {
			return null;
		}

		// We go through FloatHorizontalRange because it has been observed in bi-di text
		// that the clientRects are not coming in sorted from the browser

		const result: FloatHorizontalRange[] = [];
		for (let i = 0, len = clientRects.length; i < len; i++) {
			const clientRect = clientRects[i];
			result[i] = new FloatHorizontalRange(Math.max(0, (clientRect.left - clientRectDeltaLeft) / clientRectScale), clientRect.width / clientRectScale);
		}

		return this._mergeAdjacentRanges(result);
	}

	public static readHorizontalRanges(domNode: HTMLElement, startChildIndex: number, startOffset: number, endChildIndex: number, endOffset: number, context: DomReadingContext): FloatHorizontalRange[] | null {
		// Panic check
		const min = 0;
		const max = domNode.children.length - 1;
		if (min > max) {
			return null;
		}
		startChildIndex = Math.min(max, Math.max(min, startChildIndex));
		endChildIndex = Math.min(max, Math.max(min, endChildIndex));
		const startObject = domNode.children[startChildIndex] as HTMLElement;
		const endObject = domNode.children[endChildIndex] as HTMLElement;
		// An object replacement character's glyph has no advance in some fonts. Its reserved box owns both caret edges.
		if (startChildIndex === endChildIndex && startObject.dataset.ashInlineObject === 'true') {
			const box = startObject.getBoundingClientRect();
			context.markDidDomLayout();
			const left = (box.left - context.clientRectDeltaLeft) / context.clientRectScale;
			const right = (box.right - context.clientRectDeltaLeft) / context.clientRectScale;
			return [new FloatHorizontalRange(startOffset === 0 ? left : right, startOffset === endOffset ? 0 : right - left)];
		}

		if (startChildIndex === endChildIndex && startOffset === endOffset && startOffset === 0 && !domNode.children[startChildIndex].firstChild) {
			// We must find the position at the beginning of a <span>
			// To cover cases of empty <span>s, avoid using a range and use the <span>'s bounding box
			const clientRects = domNode.children[startChildIndex].getClientRects();
			context.markDidDomLayout();
			return this._createHorizontalRangesFromClientRects(clientRects, context.clientRectDeltaLeft, context.clientRectScale);
		}

		// If crossing over to a span only to select offset 0, then use the previous span's maximum offset
		// Chrome is buggy and doesn't handle 0 offsets well sometimes.
		if (startChildIndex !== endChildIndex) {
			if (endChildIndex > 0 && endOffset === 0) {
				endChildIndex--;
				endOffset = Constants.MAX_SAFE_SMALL_INTEGER;
			}
		}

		let startElement = domNode.children[startChildIndex].firstChild;
		let endElement = domNode.children[endChildIndex].firstChild;

		if (!startElement || !endElement) {
			// When having an empty <span> (without any text content), try to move to the previous <span>
			if (!startElement && startOffset === 0 && startChildIndex > 0) {
				startElement = domNode.children[startChildIndex - 1].firstChild;
				startOffset = Constants.MAX_SAFE_SMALL_INTEGER;
			}
			if (!endElement && endOffset === 0 && endChildIndex > 0) {
				endElement = domNode.children[endChildIndex - 1].firstChild;
				endOffset = Constants.MAX_SAFE_SMALL_INTEGER;
			}
		}

		if (!startElement || !endElement) {
			return null;
		}

		startOffset = Math.min(startElement.textContent!.length, Math.max(0, startOffset));
		endOffset = Math.min(endElement.textContent!.length, Math.max(0, endOffset));

		const clientRects = this._readClientRects(startElement, startOffset, endElement, endOffset, context.endNode);
		context.markDidDomLayout();
		const ranges = this._createHorizontalRangesFromClientRects(clientRects, context.clientRectDeltaLeft, context.clientRectScale) ?? [];
		for (const [element, include] of [[startObject, startOffset === 0], [endObject, endOffset > 0]] as const) {
			if (!include || element.dataset.ashInlineObject !== 'true') continue;
			const box = element.getBoundingClientRect();
			context.markDidDomLayout();
			ranges.push(new FloatHorizontalRange((box.left - context.clientRectDeltaLeft) / context.clientRectScale, box.width / context.clientRectScale));
		}
		return ranges.length > 0 ? this._mergeAdjacentRanges(ranges) : null;
	}
}
