import { SelectionDirection, type Selection } from "../../../../common/core/selection.js";
import { Position } from "../../../../common/core/position.js";
import { type TextModel } from "../../../../common/model/textModel.js";
import { isHighSurrogate, isLowSurrogate } from '../../../../../base/common/strings.js';
import { type IDisposable } from '../../../../../base/common/lifecycle.js';
import { type IComputedEditorOptions } from '../../../../common/config/editorOptions.js';

/** Keeps the screen-reader mirror bounded for the same reason as the native text window. */
export const SCREEN_READER_CONTENT_LENGTH = 32 * 1_024;
/** Matches VS Code's line-oriented accessibility paging model. */
export const DEFAULT_SCREEN_READER_PAGE_SIZE = 500;

const SCREEN_READER_PAGE_SEPARATOR = String.fromCharCode(8230);

export interface ScreenReaderContentOptions {
	/** Number of logical lines included in one accessibility page. */
	readonly pageSize?: number;
}

export interface ScreenReaderContentSegment {
	/** Absolute model offsets represented by this segment. */
	readonly modelStartOffset: number;
	readonly modelEndOffset: number;
	/** UTF-16 offsets of this segment inside the projected `text`. */
	readonly contentStartOffset: number;
	readonly contentEndOffset: number;
}

export interface ScreenReaderContentState {
	readonly startOffset: number;
	readonly endOffset: number;
	/** Model line and column represented by the first UTF-16 unit in `text`. */
	readonly startLineIndex: number;
	readonly startColumn: number;
	readonly text: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
	readonly anchorOffset: number;
	readonly activeOffset: number;
	/** Model-to-DOM mappings for line pages and bounded text windows. */
	readonly segments: readonly ScreenReaderContentSegment[];
}

export interface ScreenReaderContentLayout {
	readonly left: number;
	readonly top: number;
	readonly width: number;
	readonly height: number;
	readonly lineHeight: number;
}

export interface IScreenReaderContent extends IDisposable {
	onWillCut(): void;
	onWillPaste(): void;
	onFocusChange(focused: boolean): void;
	onConfigurationChanged(options: IComputedEditorOptions): void;
	updateScreenReaderContent(primarySelection: Selection): void;
	updateScrollTop(primarySelection: Selection): void;
}

export function createScreenReaderContentState(
	model: TextModel,
	selection: Selection,
	options: ScreenReaderContentOptions = {},
): ScreenReaderContentState {
	const selectionStart = model.offsetAt(selection.getStartPosition());
	const selectionEnd = model.offsetAt(selection.getEndPosition());
	const activeOffset = model.offsetAt(selection.getPosition());
	const pageSize = options.pageSize === undefined ? undefined : normalizePageSize(options.pageSize);
	const modelSegments = pageSize === undefined
		? [createScreenReaderWindow(model.length, selectionStart, selectionEnd, activeOffset)]
		: createScreenReaderPageWindows(model, selectionStart, selectionEnd, activeOffset, pageSize);
	const snapshot = model.createVersionedSnapshot();
	const safeModelSegments = modelSegments.map(segment => avoidSurrogateSplit(snapshot, model.length, segment));
	let text = "";
	let contentOffset = 0;
	const segments: ScreenReaderContentSegment[] = [];
	for (const [index, segment] of safeModelSegments.entries()) {
		if (index > 0) {
			text += SCREEN_READER_PAGE_SEPARATOR;
			contentOffset += SCREEN_READER_PAGE_SEPARATOR.length;
		}
		const segmentText = snapshot.getTextBetweenOffsets(segment.startOffset, segment.endOffset);
		const contentStartOffset = contentOffset;
		text += segmentText;
		contentOffset += segmentText.length;
		segments.push(Object.freeze({
			modelStartOffset: segment.startOffset,
			modelEndOffset: segment.endOffset,
			contentStartOffset,
			contentEndOffset: contentOffset,
		}));
	}
	const frozenSegments = Object.freeze(segments);
	const startPosition = model.positionAt(frozenSegments[0]!.modelStartOffset);
	const stateWithoutOffsets = {
		startOffset: frozenSegments[0]!.modelStartOffset,
		endOffset: frozenSegments[frozenSegments.length - 1]!.modelEndOffset,
		startLineIndex: startPosition.lineNumber - 1,
		startColumn: startPosition.column - 1,
		text,
		segments: frozenSegments,
	};
	const orderedSelectionStart = contentOffsetAtModelOffset(stateWithoutOffsets, selectionStart, "start");
	const orderedSelectionEnd = contentOffsetAtModelOffset(stateWithoutOffsets, selectionEnd, "end");
	const anchorAffinity = selection.getDirection() === SelectionDirection.LTR ? "start" : "end";
	const activeAffinity = selection.getDirection() === SelectionDirection.LTR ? "end" : "start";
	return Object.freeze({
		...stateWithoutOffsets,
		selectionStart: orderedSelectionStart,
		selectionEnd: orderedSelectionEnd,
		anchorOffset: contentOffsetAtModelOffset(stateWithoutOffsets, model.offsetAt(selection.getSelectionStart()), anchorAffinity),
		activeOffset: contentOffsetAtModelOffset(stateWithoutOffsets, activeOffset, activeAffinity),
	});
}

export function createScreenReaderWindow(
	modelLength: number,
	selectionStart: number,
	selectionEnd: number,
	activeOffset: number,
): { readonly startOffset: number; readonly endOffset: number } {
	return createBoundedScreenReaderWindow(
		modelLength,
		selectionStart,
		selectionEnd,
		activeOffset,
		SCREEN_READER_CONTENT_LENGTH,
	);
}

/** Maps a model offset to a projected UTF-16 offset, including page separators. */
export function contentOffsetAtModelOffset(
	state: Pick<ScreenReaderContentState, "segments" | "startOffset" | "endOffset">,
	modelOffset: number,
	affinity: "start" | "end" = "start",
): number {
	const segments = state.segments;
	if (segments.length === 0) return 0;
	const offset = clampOffset(modelOffset, Math.max(state.endOffset, state.startOffset));
	let previous: ScreenReaderContentSegment | undefined;
	for (const segment of segments) {
		if (offset < segment.modelStartOffset) {
			return affinity === "end"
				? segment.contentStartOffset
				: previous?.contentEndOffset ?? segment.contentStartOffset;
		}
		if (offset <= segment.modelEndOffset) {
			return segment.contentStartOffset + offset - segment.modelStartOffset;
		}
		previous = segment;
	}
	return segments[segments.length - 1]!.contentEndOffset;
}

/** Maps a projected UTF-16 offset back to the nearest model offset. */
export function modelOffsetAtContentOffset(
	state: Pick<ScreenReaderContentState, "text" | "segments">,
	contentOffset: number,
	affinity: "start" | "end" = "start",
): number {
	const segments = state.segments;
	if (segments.length === 0) return 0;
	const offset = clampScreenReaderOffset(contentOffset, state.text.length);
	let previous: ScreenReaderContentSegment | undefined;
	for (const segment of segments) {
		if (previous && offset >= previous.contentEndOffset && offset <= segment.contentStartOffset) {
			return affinity === "end" ? segment.modelStartOffset : previous.modelEndOffset;
		}
		if (offset <= segment.contentEndOffset && offset >= segment.contentStartOffset) {
			return segment.modelStartOffset + offset - segment.contentStartOffset;
		}
		previous = segment;
	}
	return segments[segments.length - 1]!.modelEndOffset;
}

/** Returns the uniform line offset used to scroll a mirror to one model position. */
export function screenReaderLineOffsetAtModelOffset(
	state: Pick<ScreenReaderContentState, "text" | "segments" | "startOffset" | "endOffset">,
	modelOffset: number,
): number {
	const contentOffset = contentOffsetAtModelOffset(
		state,
		modelOffset,
		"start",
	);
	let result = 0;
	for (let index = 0; index < contentOffset; index += 1) {
		if (state.text.charCodeAt(index) === 10) result += 1;
	}
	return result;
}

export function domPointAtOffset(root: HTMLElement, offset: number): { readonly node: Text; readonly offset: number } | undefined {
	const textNodes = collectTextNodes(root);
	let remaining = clampScreenReaderOffset(offset, textLength(root));
	for (const node of textNodes) {
		if (remaining <= node.data.length) return { node, offset: remaining };
		remaining -= node.data.length;
	}
	const last = textNodes.at(-1);
	return last ? { node: last, offset: last.data.length } : undefined;
}

export function domOffsetAtPoint(root: HTMLElement, node: Node | null, offset: number): number | undefined {
	if (!node || !root.contains(node)) return undefined;
	if (node.nodeType === 3) {
		return offsetBeforeNode(root, node) + clampOffset(offset, node.textContent?.length ?? 0);
	}
	if (node.nodeType !== 1 && node !== root) return undefined;
	const children = Array.from(node.childNodes);
	const childIndex = clampOffset(offset, children.length);
	return offsetBeforeNode(root, node) + children
		.slice(0, childIndex)
		.reduce((total, child) => total + textLength(child), 0);
}

export function clampScreenReaderOffset(offset: number, textLength: number): number {
	return Math.min(Math.max(0, Number.isSafeInteger(offset) ? offset : 0), textLength);
}

function collectTextNodes(root: Node): Text[] {
	const result: Text[] = [];
	const visit = (node: Node): void => {
		if (node.nodeType === 3) {
			result.push(node as Text);
			return;
		}
		for (const child of Array.from(node.childNodes)) visit(child);
	};
	visit(root);
	return result;
}

function offsetBeforeNode(root: Node, node: Node): number {
	let current: Node | null = node;
	let result = 0;
	while (current && current !== root) {
		const parent: Node | null = current.parentNode;
		if (!parent) return result;
		for (const sibling of Array.from(parent.childNodes) as Node[]) {
			if (sibling === current) break;
			result += textLength(sibling);
		}
		current = parent;
	}
	return result;
}

function textLength(node: Node): number {
	return node.nodeType === 3
		? node.textContent?.length ?? 0
		: (Array.from(node.childNodes) as Node[]).reduce((total, child) => total + textLength(child), 0);
}

function clampOffset(offset: number, length: number): number {
	return Math.min(Math.max(0, Number.isSafeInteger(offset) ? offset : 0), length);
}

function normalizePageSize(pageSize: number): number {
	if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
		throw new RangeError("Screen-reader page size must be a positive safe integer");
	}
	return pageSize;
}

function createScreenReaderPageWindows(
	model: TextModel,
	selectionStart: number,
	selectionEnd: number,
	activeOffset: number,
	pageSize: number,
): readonly { readonly startOffset: number; readonly endOffset: number }[] {
	const startPage = Math.floor((model.positionAt(selectionStart).lineNumber - 1) / pageSize);
	const endPage = Math.floor((model.positionAt(selectionEnd).lineNumber - 1) / pageSize);
	const start = pageWindowForModel(model, startPage, pageSize);
	const end = pageWindowForModel(model, endPage, pageSize);
	const intervals = startPage === endPage
		? [start]
		: endPage === startPage + 1
			? [{ startOffset: start.startOffset, endOffset: end.endOffset }]
			: [start, end];
	const maxSegmentLength = Math.max(1, Math.floor(
		(SCREEN_READER_CONTENT_LENGTH - (intervals.length - 1) * SCREEN_READER_PAGE_SEPARATOR.length) / intervals.length,
	));
	return intervals.map(interval => {
		const localSelectionStart = clampModelOffset(selectionStart, interval.startOffset, interval.endOffset) - interval.startOffset;
		const localSelectionEnd = clampModelOffset(selectionEnd, interval.startOffset, interval.endOffset) - interval.startOffset;
		const localActiveOffset = clampModelOffset(activeOffset, interval.startOffset, interval.endOffset) - interval.startOffset;
		const bounded = createBoundedScreenReaderWindow(
			interval.endOffset - interval.startOffset,
			Math.min(localSelectionStart, localSelectionEnd),
			Math.max(localSelectionStart, localSelectionEnd),
			localActiveOffset,
			maxSegmentLength,
		);
		return {
			startOffset: interval.startOffset + bounded.startOffset,
			endOffset: interval.startOffset + bounded.endOffset,
		};
	});
}

function pageWindowForModel(
	model: TextModel,
	page: number,
	pageSize: number,
): { readonly startOffset: number; readonly endOffset: number } {
	const startLineIndex = page * pageSize;
	const endLineIndexExclusive = Math.min(model.lineCount, startLineIndex + pageSize);
	const startOffset = model.offsetAt(new Position((startLineIndex) + 1, (0) + 1));
	const endOffset = endLineIndexExclusive >= model.lineCount
		? model.length
		: model.offsetAt(new Position((endLineIndexExclusive) + 1, (0) + 1));
	return { startOffset, endOffset };
}

function createBoundedScreenReaderWindow(
	modelLength: number,
	selectionStart: number,
	selectionEnd: number,
	activeOffset: number,
	maximumLength: number,
): { readonly startOffset: number; readonly endOffset: number } {
	if (modelLength <= maximumLength) return { startOffset: 0, endOffset: modelLength };
	const selectionLength = selectionEnd - selectionStart;
	if (selectionLength <= maximumLength) {
		const margin = Math.floor((maximumLength - selectionLength) / 2);
		let startOffset = Math.max(0, selectionStart - margin);
		startOffset = Math.min(startOffset, modelLength - maximumLength);
		if (selectionEnd > startOffset + maximumLength) startOffset = selectionEnd - maximumLength;
		return { startOffset, endOffset: Math.min(modelLength, startOffset + maximumLength) };
	}
	const startOffset = Math.min(
		Math.max(0, activeOffset - Math.floor(maximumLength / 2)),
		modelLength - maximumLength,
	);
	return { startOffset, endOffset: startOffset + maximumLength };
}

function clampModelOffset(offset: number, startOffset: number, endOffset: number): number {
	return Math.min(Math.max(offset, startOffset), endOffset);
}

function avoidSurrogateSplit(
	snapshot: ReturnType<TextModel['createVersionedSnapshot']>,
	modelLength: number,
	segment: { readonly startOffset: number; readonly endOffset: number },
): { readonly startOffset: number; readonly endOffset: number } {
	let startOffset = segment.startOffset;
	let endOffset = segment.endOffset;
	if (startOffset > 0) {
		const boundary = snapshot.getTextBetweenOffsets(startOffset - 1, Math.min(modelLength, startOffset + 1));
		if (boundary.length >= 2 && isHighSurrogate(boundary.charCodeAt(0)) && isLowSurrogate(boundary.charCodeAt(1))) startOffset -= 1;
	}
	if (endOffset < modelLength) {
		const boundary = snapshot.getTextBetweenOffsets(Math.max(0, endOffset - 1), endOffset + 1);
		if (boundary.length >= 2 && isHighSurrogate(boundary.charCodeAt(0)) && isLowSurrogate(boundary.charCodeAt(1))) endOffset += 1;
	}
	return { startOffset, endOffset };
}
