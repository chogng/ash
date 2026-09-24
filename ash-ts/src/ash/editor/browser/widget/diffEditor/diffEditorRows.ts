import { fragment as createFragment, h, reset } from '../../../../base/browser/dom.js';
import { type DiffModel } from '../../../common/diff/diffModel.js';
import { LineDiffKind, type DiffRange, type LineDiffRow } from '../../../common/diff/lineDiff.js';
import { type FontInfo } from '../../../common/config/fontInfo.js';
import { WrappingIndent } from '../../../common/config/editorOptions.js';
import { MonospaceLineBreaksComputerFactory } from '../../../common/viewModel/monospaceLineBreaksComputer.js';

/** Rendering data for one paired source line after wrapping. */
export interface WrappedDiffRow {
	readonly height: number;
	readonly originalBreaks: readonly number[];
	readonly modifiedBreaks: readonly number[];
}

export interface DiffRowLayout {
	readonly offsets: readonly number[];
	readonly wrappedRows: readonly WrappedDiffRow[];
}

/** Computes paired row heights once so rendering, scrolling, and navigation share coordinates. */
export function computeDiffRowLayout(model: DiffModel, lineHeight: number, wrapping?: { readonly fontInfo: FontInfo; readonly column: number }): DiffRowLayout {
	const rows = model.diff?.rows ?? [];
	const offsets = [0];
	if (!wrapping) {
		for (let i = 0; i < rows.length; i++) offsets.push((i + 1) * lineHeight);
		return { offsets, wrappedRows: [] };
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
	const wrappedRows: WrappedDiffRow[] = [];
	for (let i = 0; i < rows.length; i++) {
		const height = Math.max(original[i]!.length, modified[i]!.length) * lineHeight;
		wrappedRows.push({ height, originalBreaks: original[i]!, modifiedBreaks: modified[i]! });
		offsets.push(offsets[i]! + height);
	}
	return { offsets, wrappedRows };
}

/** Finds the logical row containing a pixel offset into a diff body. */
export function diffRowAtOffset(offsets: readonly number[], offset: number): number {
	if (offsets.length < 2) return 0;
	let low = 0;
	let high = offsets.length - 1;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (offsets[middle]! <= offset) low = middle;
		else high = middle - 1;
	}
	return Math.min(low, offsets.length - 2);
}

/** Creates one side-by-side row shared by the single- and multi-diff widgets. */
export function createDiffEditorRow(ownerDocument: Document, row: LineDiffRow, model: DiffModel, lineHeight: number, active: boolean, showInlineChanges: boolean, wrapped?: WrappedDiffRow): HTMLDivElement {
	const element = h(ownerDocument, 'div');
	element.className = `stanza-diff-editor-row ${row.kind}`;
	element.classList.toggle('active', active);
	element.classList.toggle('word-wrapped', !!wrapped);
	element.style.height = `${wrapped?.height ?? lineHeight}px`;
	element.style.lineHeight = `${lineHeight}px`;
	element.append(
		createDiffCell(ownerDocument, 'original', row.kind, row.originalLineIndex,
			row.originalLineIndex === undefined ? undefined : model.original.getLineContent(row.originalLineIndex + 1),
			row.originalChanges, showInlineChanges, wrapped?.originalBreaks, model.original.getOptions().tabSize),
		createDiffCell(ownerDocument, 'modified', row.kind, row.modifiedLineIndex,
			row.modifiedLineIndex === undefined ? undefined : model.modified.getLineContent(row.modifiedLineIndex + 1),
			row.modifiedChanges, showInlineChanges, wrapped?.modifiedBreaks, model.modified.getOptions().tabSize),
	);
	return element;
}

function createDiffCell(ownerDocument: Document, side: 'original' | 'modified', kind: LineDiffKind, lineIndex: number | undefined, text: string | undefined, changes: readonly DiffRange[], showInlineChanges: boolean, breaks?: readonly number[], tabSize?: number): HTMLDivElement {
	const cell = h(ownerDocument, 'div');
	cell.className = `stanza-diff-editor-cell ${side}`;
	const number = h(ownerDocument, 'span');
	number.className = 'stanza-diff-editor-line-number';
	number.textContent = lineIndex === undefined ? '' : String(lineIndex + 1);
	const content = h(ownerDocument, 'span');
	content.className = 'stanza-diff-editor-line-content';
	if (breaks && tabSize !== undefined) content.style.tabSize = String(tabSize);
	if (text === undefined) {
		cell.classList.add('missing');
	} else {
		const changedKind = side === 'original' ? LineDiffKind.Removed : LineDiffKind.Added;
		if (breaks) projectWrappedText(ownerDocument, content, text, breaks, changes, changedKind, showInlineChanges);
		else if (showInlineChanges) projectDiffText(ownerDocument, content, text, changes, changedKind);
		else content.textContent = text;
		if (kind === LineDiffKind.Modified) cell.classList.add(side === 'original' ? 'removed' : 'added');
		else if (kind === LineDiffKind.Removed && side === 'original') cell.classList.add('removed');
		else if (kind === LineDiffKind.Added && side === 'modified') cell.classList.add('added');
	}
	cell.append(number, content);
	return cell;
}

function projectWrappedText(ownerDocument: Document, content: HTMLElement, text: string, breaks: readonly number[], changes: readonly DiffRange[], changedKind: LineDiffKind, showInlineChanges: boolean): void {
	let start = 0;
	for (const end of breaks) {
		const visualLine = h(ownerDocument, 'span');
		visualLine.className = 'stanza-diff-editor-visual-line';
		const segment = text.slice(start, end);
		if (showInlineChanges) {
			const segmentChanges = changes
				.filter(change => change.endColumn > start && change.startColumn < end)
				.map(change => ({
					startColumn: Math.max(0, change.startColumn - start),
					endColumn: Math.min(end, change.endColumn) - start,
				}));
			projectDiffText(ownerDocument, visualLine, segment, segmentChanges, changedKind);
		} else {
			visualLine.textContent = segment;
		}
		content.append(visualLine);
		start = end;
	}
}

function projectDiffText(ownerDocument: Document, target: HTMLElement, text: string, changes: readonly DiffRange[], changedKind: LineDiffKind): void {
	const fragment = createFragment(ownerDocument);
	let previousEnd = 0;
	for (const change of changes) {
		fragment.append(text.slice(previousEnd, change.startColumn));
		const changed = h(ownerDocument, 'span');
		changed.className = `stanza-diff-editor-inline ${changedKind}`;
		changed.textContent = text.slice(change.startColumn, change.endColumn);
		fragment.append(changed);
		previousEnd = change.endColumn;
	}
	fragment.append(text.slice(previousEnd));
	reset(target, fragment);
}
