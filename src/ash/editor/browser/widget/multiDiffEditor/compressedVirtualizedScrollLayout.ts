import { type FontInfo } from '../../../common/config/fontInfo.js';
import type { HideUnchangedRegionsOptions } from '../../../common/config/diffEditor.js';
import { WrappingIndent } from '../../../common/config/editorOptions.js';
import { type DiffModel } from '../../../common/diff/diffModel.js';
import { MonospaceLineBreaksComputerFactory } from '../../../common/viewModel/monospaceLineBreaksComputer.js';

export interface DiffRowLayout {
	readonly height: number;
	getOffset(rowIndex: number): number;
}

export interface DiffPreviewRow {
	readonly rowIndex: number;
	readonly top: number;
	readonly height: number;
	/** A disclosure row replaces this many unchanged rows. */
	readonly hiddenCount: number;
}

export interface DiffPreviewLayout extends DiffRowLayout {
	getVisibleRows(top: number, height: number): readonly DiffPreviewRow[];
}

/** Sparse, fixed-height review projection; source row identities never become screen coordinates. */
export function computeDiffPreviewLayout(model: DiffModel, lineHeight: number, options: HideUnchangedRegionsOptions, expanded: ReadonlySet<number>): DiffPreviewLayout {
	const diff = model.diff;
	const length = diff?.rows.length ?? 0;
	const segments: { start: number; end: number; top: number; hidden: boolean; }[] = [];
	let next = 0;
	let height = 0;
	const add = (start: number, end: number, hidden: boolean): void => {
		if (start >= end) return;
		segments.push({ start, end, top: height, hidden });
		// Match the existing diff disclosure's 40px extent in the outer scroll surface.
		height += hidden ? 40 : (end - start) * lineHeight;
	};
	if (options.enabled && diff?.hunks.length) {
		for (const [start, end] of diff.rows.unchangedRanges()) {
			const from = start + (start === 0 ? 0 : options.contextLineCount);
			const to = end - (end === length ? 0 : options.contextLineCount);
			if (to - from < options.minimumLineCount || expanded.has(from)) continue;
			add(next, from, false);
			add(from, to, true);
			next = to;
		}
	}
	add(next, length, false);
	return {
		height,
		getOffset: row => {
			let low = 0;
			let high = segments.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if (segments[middle]!.end <= row) low = middle + 1;
				else high = middle;
			}
			const segment = segments[low];
			return segment ? segment.top + (segment.hidden ? 0 : Math.max(0, row - segment.start) * lineHeight) : height;
		},
		getVisibleRows: (top, viewportHeight) => {
			const result: DiffPreviewRow[] = [];
			const bottom = top + viewportHeight;
			for (const segment of segments) {
				if (segment.top >= bottom) break;
				if (segment.hidden) {
					if (segment.top + 40 > top) result.push({ rowIndex: segment.start, top: segment.top, height: 40, hiddenCount: segment.end - segment.start });
				} else {
					const start = Math.max(segment.start, segment.start + Math.floor((top - segment.top) / lineHeight));
					const end = Math.min(segment.end, segment.start + Math.ceil((bottom - segment.top) / lineHeight));
					for (let row = start; row < end; row++) result.push({ rowIndex: row, top: segment.top + (row - segment.start) * lineHeight, height: lineHeight, hiddenCount: 0 });
				}
			}
			return result;
		},
	};
}

/** Retains only wrapping exceptions; unwrapped offsets are constant-time arithmetic. */
export function computeDiffRowLayout(model: DiffModel, lineHeight: number, wrapping?: { readonly fontInfo: FontInfo; readonly column: number; }): DiffRowLayout {
	const rows = model.diff?.rows;
	const length = rows?.length ?? 0;
	if (!wrapping || !rows) return { height: length * lineHeight, getOffset: index => index * lineHeight };
	const factory = new MonospaceLineBreaksComputerFactory('([{', ' \t})]?|/&.,;!?:');
	const wrappedRows: number[] = [];
	const extraHeights: number[] = [];
	let extraHeight = 0;
	// Bound temporary line-break requests even when a comparison has millions of lines.
	for (let start = 0; start < length; start += 256) {
		const end = Math.min(length, start + 256);
		const batch = Array.from({ length: end - start }, (_, offset) => rows.get(start + offset)!);
		const compute = (source: typeof model.original, side: 'originalLineIndex' | 'modifiedLineIndex'): number[] => {
			const computer = factory.createLineBreaksComputer({
				getLineContent: line => source.getLineContent(line), getLineInjectedText: () => null,
			}, wrapping.fontInfo, source.getOptions().tabSize, wrapping.column, WrappingIndent.None, 'normal', false);
			for (const row of batch) if (row[side] !== undefined) computer.addRequest(row[side]! + 1, null);
			const breaks = computer.finalize();
			let next = 0;
			return batch.map(row => row[side] === undefined ? 1 : breaks[next++]?.breakOffsets.length ?? 1);
		};
		const original = compute(model.original, 'originalLineIndex');
		const modified = compute(model.modified, 'modifiedLineIndex');
		for (let offset = 0; offset < batch.length; offset++) {
			const extra = (Math.max(original[offset]!, modified[offset]!) - 1) * lineHeight;
			if (!extra) continue;
			extraHeight += extra;
			wrappedRows.push(start + offset);
			extraHeights.push(extraHeight);
		}
	}
	return {
		height: length * lineHeight + extraHeight,
		getOffset: index => {
			let low = 0;
			let high = wrappedRows.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if (wrappedRows[middle]! < index) low = middle + 1;
				else high = middle;
			}
			return index * lineHeight + (extraHeights[low - 1] ?? 0);
		},
	};
}

export interface ICompressedVirtualizedItemRange {
	readonly top: number;
	readonly height: number;
}

/** Keeps the same file and intra-file position visible when item heights change. */
export function mapScrollAnchor(
	oldItems: readonly ICompressedVirtualizedItemRange[],
	newItems: readonly ICompressedVirtualizedItemRange[],
	scrollTop: number,
): number {
	if (oldItems.length !== newItems.length) throw new RangeError('Scroll anchoring requires stable file order');
	if (oldItems.length === 0 || scrollTop <= oldItems[0]!.top) return scrollTop;

	let low = 0;
	let high = oldItems.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		const item = oldItems[middle]!;
		if (item.top + item.height < scrollTop) low = middle + 1;
		else high = middle;
	}
	const index = Math.min(low, oldItems.length - 1);
	const before = oldItems[index]!;
	const after = newItems[index]!;
	const offset = Math.max(0, Math.min(before.height, scrollTop - before.top));
	return after.top + Math.min(offset, after.height);
}
