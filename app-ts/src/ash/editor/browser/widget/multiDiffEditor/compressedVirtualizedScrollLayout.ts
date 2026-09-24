import { type FontInfo } from '../../../common/config/fontInfo.js';
import { WrappingIndent } from '../../../common/config/editorOptions.js';
import { type DiffModel } from '../../../common/diff/diffModel.js';
import { MonospaceLineBreaksComputerFactory } from '../../../common/viewModel/monospaceLineBreaksComputer.js';

export interface DiffRowLayout {
	readonly offsets: readonly number[];
}

/** Estimates paired row heights for continuous multi-file scrolling and change navigation. */
export function computeDiffRowLayout(model: DiffModel, lineHeight: number, wrapping?: { readonly fontInfo: FontInfo; readonly column: number }): DiffRowLayout {
	const rows = model.diff?.rows ?? [];
	const offsets = [0];
	if (!wrapping) {
		for (let i = 0; i < rows.length; i++) offsets.push((i + 1) * lineHeight);
		return { offsets };
	}
	const factory = new MonospaceLineBreaksComputerFactory('([{', ' \t})]?|/&.,;!?:');
	const compute = (source: typeof model.original, lineIndices: readonly (number | undefined)[]): readonly number[][] => {
		const computer = factory.createLineBreaksComputer({
			getLineContent: line => source.getLineContent(line),
			getLineInjectedText: () => null,
		}, wrapping.fontInfo, source.getOptions().tabSize, wrapping.column, WrappingIndent.None, 'normal', false);
		for (const index of lineIndices) if (index !== undefined) computer.addRequest(index + 1, null);
		const breaks = computer.finalize();
		let next = 0;
		return lineIndices.map(index => {
			if (index === undefined) return [0];
			return breaks[next++]?.breakOffsets ?? [source.getLineContent(index + 1).length];
		});
	};
	const original = compute(model.original, rows.map(row => row.originalLineIndex));
	const modified = compute(model.modified, rows.map(row => row.modifiedLineIndex));
	for (let i = 0; i < rows.length; i++) {
		const height = Math.max(original[i]!.length, modified[i]!.length) * lineHeight;
		offsets.push(offsets[i]! + height);
	}
	return { offsets };
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
