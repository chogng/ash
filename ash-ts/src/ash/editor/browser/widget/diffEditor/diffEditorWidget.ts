import "./style.css";
import { addDisposableListener, fragment as createFragment, getWindow, h, isHTMLElement, reset, stopEvent } from "../../../../base/browser/dom.js";
import { FastDomNode } from "../../../../base/browser/fastDomNode.js";
import { getClientArea } from "../../../../base/browser/dom.js";
import { observeResize } from "../../../../base/browser/observer.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { Emitter } from '../../../../base/common/event.js';
import { isFiniteNumber, isNonNegativeSafeInteger, rot } from "../../../../base/common/numbers.js";
import { DiffModel } from "../../../common/diff/diffModel.js";
import { type IDimension } from '../../../common/core/2d/dimension.js';
import { LineDiffKind, type LineDiff, type LineDiffRow } from "../../../common/diff/lineDiff.js";
import { createBareFontInfoFromRawSettings } from '../../../common/config/fontInfoFromSettings.js';
import { FontMeasurements } from '../../config/fontMeasurements.js';
import { type BareFontInfo, type FontInfo } from '../../../common/config/fontInfo.js';
import { applyFontInfo } from "../../config/domFontInfo.js";
import { OverviewRulerFeature } from './features/overviewRulerFeature.js';
import { computeDiffRowLayout, createDiffEditorRow, diffRowAtOffset, type WrappedDiffRow } from "./diffEditorRows.js";
import { type IDiffEditor } from '../../editorBrowser.js';
import { type ICodeEditorService } from '../../services/codeEditorService.js';
import { localize, onDidChangeNls } from '../../../../nls.js';

const DEFAULT_LINE_HEIGHT = 20;
const DEFAULT_OVERSCAN_ROW_COUNT = 8;
let diffEditorId = 0;

export interface DiffEditorWidgetOptions {
	readonly container: HTMLElement;
	readonly model: DiffModel;
	readonly lineHeight?: number;
	readonly fontFamily?: string;
	readonly fontSize?: number;
	readonly fontLigatures?: boolean;
	readonly showLineNumbers?: boolean;
	readonly showInlineChanges?: boolean;
	readonly loopChanges?: boolean;
	readonly overscanRowCount?: number;
	readonly originalAriaLabel?: string;
	readonly modifiedAriaLabel?: string;
	readonly codeEditorService?: ICodeEditorService;
	readonly wordWrap?: boolean;
}

/**
 * Read-only, virtualized side-by-side presentation of one DiffModel.
 *
 * The common model owns source versions, computation, correspondence, and
 * inline change ranges. This browser component owns only scroll geometry and
 * DOM projection; it never owns source text or diff computation.
 */
export class DiffEditorWidget extends Disposable implements IDiffEditor {
	readonly element: HTMLDivElement;
	private readonly id = `ash-diff-editor-${++diffEditorId}`;
	private readonly contentElement: HTMLDivElement;
	private readonly contentNode: FastDomNode<HTMLDivElement>;
	private readonly rowsElement: HTMLDivElement;
	private readonly rowsNode: FastDomNode<HTMLDivElement>;
	private readonly overviewRuler: OverviewRulerFeature;
	private readonly layoutEmitter = this._register(new Emitter<IDimension>());
	private readonly accessibilityStatusElement: HTMLDivElement;
	private readonly incompleteStatusElement: HTMLDivElement;
	private readonly model: DiffModel;
	private readonly lineHeight: number;
	private readonly overscanRowCount: number;
	private currentDiff: LineDiff | undefined;
	private renderedStartRow = -1;
	private renderedEndRow = -1;
	private viewportWidth = 0;
	private viewportHeight = 0;
	private activeChangeRow = -1;
	private readonly showInlineChanges: boolean;
	private readonly loopChanges: boolean;
	private readonly showLineNumbers: boolean;
	private readonly bareFontInfo: BareFontInfo;
	private fontInfo: FontInfo | undefined;
	private configuredWordWrap: boolean;
	private temporaryWordWrap: boolean | undefined;
	private rowOffsets: readonly number[] = [0];
	private wrappedRows: readonly WrappedDiffRow[] = [];

	constructor(options: DiffEditorWidgetOptions) {
		super();
		options.codeEditorService?.willCreateDiffEditor();
		validateOptions(options);
		const ownerDocument = options.container.ownerDocument;
		this.model = options.model;
		this.lineHeight = options.lineHeight ?? DEFAULT_LINE_HEIGHT;
		this.overscanRowCount = options.overscanRowCount ?? DEFAULT_OVERSCAN_ROW_COUNT;
		this.showInlineChanges = options.showInlineChanges ?? true;
		this.loopChanges = options.loopChanges ?? true;
		this.showLineNumbers = options.showLineNumbers ?? true;
		this.configuredWordWrap = options.wordWrap ?? false;
		this.currentDiff = this.model.diff;
		this.element = h(ownerDocument, "div");
		this.contentElement = h(ownerDocument, "div");
		this.contentNode = new FastDomNode(this.contentElement);
		this.rowsElement = h(ownerDocument, "div");
		this.rowsNode = new FastDomNode(this.rowsElement);
		this.accessibilityStatusElement = h(ownerDocument, "div");
		this.incompleteStatusElement = h(ownerDocument, "div");
		this.element.className = "stanza-diff-editor";
		this.element.classList.toggle('word-wrapped', this.wordWrap);
		this.element.classList.toggle("hide-line-numbers", options.showLineNumbers === false);
		this.bareFontInfo = createBareFontInfoFromRawSettings({
			fontFamily: options.fontFamily,
			fontSize: options.fontSize,
			fontLigatures: options.fontLigatures,
			lineHeight: this.lineHeight,
		}, getWindow(options.container).devicePixelRatio);
		applyFontInfo(this.element, this.bareFontInfo);
		this.element.tabIndex = 0;
		this.element.setAttribute("role", "region");
		this.element.setAttribute("aria-label", `Side-by-side diff editor. Original: ${options.originalAriaLabel ?? "Original"}. Modified: ${options.modifiedAriaLabel ?? "Modified"}.`);
		this.contentNode.setClassName("stanza-diff-editor-content");
		this.rowsNode.setClassName("stanza-diff-editor-rows");
		this.accessibilityStatusElement.className = "stanza-diff-editor-accessibility-status";
		this.accessibilityStatusElement.setAttribute("aria-live", "polite");
		this.accessibilityStatusElement.setAttribute("aria-atomic", "true");
		this.incompleteStatusElement.className = "stanza-diff-editor-incomplete-status";
		this.incompleteStatusElement.setAttribute("role", "status");
		this.incompleteStatusElement.setAttribute("aria-live", "polite");
		this.updateIncompleteStatus();
		this.contentElement.append(this.rowsElement);
		this.element.append(this.contentElement, this.incompleteStatusElement);
		options.container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this.overviewRuler = this._register(new OverviewRulerFeature(this.element, this.model, () => this.rowOffsets, this.layoutEmitter.event));
		this.element.append(this.accessibilityStatusElement);
		this._register(addDisposableListener(this.element, "scroll", () => this.project()));
		this._register(addDisposableListener(this.element, "keydown", event => this.handleKeydown(event)));
		this._register(this.model.onDidChange(() => this.refresh()));
		this._register(onDidChangeNls(() => this.updateIncompleteStatus()));
		this._register(observeResize(this.element, ([entry]) => {
			if (entry) this.layout({ width: entry.contentRect.width, height: entry.contentRect.height });
		}));
		if (options.codeEditorService) {
			options.codeEditorService.addDiffEditor(this);
			this._register(toDisposable(() => options.codeEditorService?.removeDiffEditor(this)));
		}
		this.layout(getClientArea(this.element));
	}

	getId(): string {
		return this.id;
	}

	get diff(): LineDiff | undefined {
		return this.currentDiff;
	}

	get wordWrap(): boolean {
		return this.temporaryWordWrap ?? this.configuredWordWrap;
	}

	setConfiguredWordWrap(enabled: boolean): void {
		this.configuredWordWrap = enabled;
		this.updateWordWrap();
	}

	toggleWordWrap(): void {
		this.temporaryWordWrap = this.temporaryWordWrap === undefined ? !this.wordWrap : undefined;
		this.updateWordWrap();
		this.accessibilityStatusElement.textContent = this.wordWrap
			? localize('wordWrap.enabled', 'Word wrap on')
			: localize('wordWrap.disabled', 'Word wrap off');
	}

	private updateWordWrap(): void {
		this.element.classList.toggle('word-wrapped', this.wordWrap);
		this.recomputeRows();
		this.project(true);
	}

	/** The currently revealed changed row, or -1 before change navigation starts. */
	get currentChangeRow(): number {
		return this.activeChangeRow;
	}

	layout(size: IDimension = getClientArea(this.element)): void {
		if (!isFiniteNumber(size.width) || size.width < 0 || !isFiniteNumber(size.height) || size.height < 0) {
			throw new RangeError("Diff editor widget layout size must be finite and non-negative");
		}
		const widthChanged = this.viewportWidth !== size.width;
		this.viewportWidth = size.width;
		this.viewportHeight = size.height;
		if (widthChanged || this.rowOffsets.length !== (this.currentDiff?.rows.length ?? 0) + 1) this.recomputeRows();
		this.project(true);
	}

	private refresh(): void {
		this.currentDiff = this.model.diff;
		this.renderedStartRow = -1;
		this.renderedEndRow = -1;
		this.activeChangeRow = -1;
		this.accessibilityStatusElement.textContent = this.model.state.kind === "loading"
			? "Computing differences"
			: this.model.state.kind === "error"
				? `Could not compute differences: ${this.model.state.error.message}`
				: "";
		this.updateIncompleteStatus();
		this.recomputeRows();
		this.project(true);
	}

	private updateIncompleteStatus(): void {
		this.incompleteStatusElement.hidden = this.model.state.kind !== "ready" || !this.model.state.quitEarly;
		this.incompleteStatusElement.textContent = this.incompleteStatusElement.hidden
			? ""
			: localize('diffEditor.incomplete', 'Diff computation stopped after the time limit. Results may be incomplete.');
	}

	revealOriginalLine(lineIndex: number): void {
		this.revealLine("originalLineIndex", lineIndex);
	}

	revealModifiedLine(lineIndex: number): void {
		this.revealLine("modifiedLineIndex", lineIndex);
	}

	/** Reveals the next changed row, wrapping to the first changed row when needed. */
	nextChange(): number | undefined {
		return this.selectRelativeChange(1);
	}

	/** Reveals the previous changed row, wrapping to the final changed row when needed. */
	previousChange(): number | undefined {
		return this.selectRelativeChange(-1);
	}

	private revealLine(side: "originalLineIndex" | "modifiedLineIndex", lineIndex: number): void {
		if (!isNonNegativeSafeInteger(lineIndex)) {
			throw new RangeError("Stanza diff line index must be a non-negative safe integer");
		}
		const diff = this.currentDiff;
		if (!diff) throw new Error("Diff results are not ready");
		const rowIndex = diff.rows.findIndex(row => row[side] === lineIndex);
		if (rowIndex < 0) throw new RangeError("Stanza diff line index is outside its source model");
		this.revealRow(rowIndex);
	}

	private selectRelativeChange(delta: -1 | 1): number | undefined {
		const diff = this.currentDiff;
		if (!diff) {
			this.accessibilityStatusElement.textContent = "Computing differences";
			return undefined;
		}
		const changedRows = diff.rows.flatMap((row, index) => row.kind === LineDiffKind.Unchanged ? [] : [index]);
		if (changedRows.length === 0) {
			this.accessibilityStatusElement.textContent = "No differences";
			return undefined;
		}
		const currentIndex = changedRows.indexOf(this.activeChangeRow);
		const selectedIndex = currentIndex < 0
			? delta > 0 ? 0 : changedRows.length - 1
			: this.loopChanges
				? rot(currentIndex + delta, changedRows.length)
				: Math.max(0, Math.min(changedRows.length - 1, currentIndex + delta));
		const rowIndex = changedRows[selectedIndex]!;
		this.activeChangeRow = rowIndex;
		this.revealRow(rowIndex);
		const row = diff.rows[rowIndex]!;
		this.accessibilityStatusElement.textContent = `Change ${selectedIndex + 1} of ${changedRows.length}, ${diffRowLocation(row)}`;
		return rowIndex;
	}

	private revealRow(rowIndex: number): void {
		const rowTop = this.rowOffsets[rowIndex]!;
		const rowBottom = this.rowOffsets[rowIndex + 1]!;
		const viewportBottom = this.element.scrollTop + this.viewportHeight;
		if (rowTop < this.element.scrollTop) this.element.scrollTop = rowTop;
		else if (rowBottom > viewportBottom) this.element.scrollTop = Math.max(0, rowBottom - this.viewportHeight);
		this.project(true);
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState('AltGraph')) return;
		if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'z') {
			stopEvent(event);
			this.toggleWordWrap();
			return;
		}
		if (event.key !== "F7" || event.ctrlKey || event.metaKey || event.altKey) return;
		stopEvent(event);
		if (event.shiftKey) this.previousChange();
		else this.nextChange();
	}

	private project(force = false): void {
		this.layoutEmitter.fire({ width: this.viewportWidth, height: this.viewportHeight });
		this.incompleteStatusElement.style.top = `${this.element.scrollTop}px`;
		const rows = this.currentDiff?.rows ?? [];
		const contentHeight = this.rowOffsets[rows.length] ?? 0;
		this.contentNode.setHeight(contentHeight);
		const firstVisibleRow = diffRowAtOffset(this.rowOffsets, this.element.scrollTop);
		const startRow = Math.max(0, firstVisibleRow - this.overscanRowCount);
		const lastVisibleOffset = Math.max(this.element.scrollTop, this.element.scrollTop + this.viewportHeight - 0.001);
		const endRow = Math.min(rows.length, diffRowAtOffset(this.rowOffsets, lastVisibleOffset) + 1 + this.overscanRowCount);
		if (!force && startRow === this.renderedStartRow && endRow === this.renderedEndRow) return;
		const fragment = createFragment(this.element.ownerDocument);
		for (let rowIndex = startRow; rowIndex < endRow; rowIndex += 1) {
			const row = rows[rowIndex]!;
			fragment.append(createDiffEditorRow(
				this.element.ownerDocument, row, this.model, this.lineHeight,
				rowIndex === this.activeChangeRow, this.showInlineChanges,
				this.wordWrap ? this.wrappedRows[rowIndex] : undefined,
			));
		}
		this.rowsNode.setTop(this.rowOffsets[startRow] ?? 0);
		reset(this.rowsElement, fragment);
		this.renderedStartRow = startRow;
		this.renderedEndRow = endRow;
	}

	private recomputeRows(): void {
		let wrapping: { readonly fontInfo: FontInfo; readonly column: number } | undefined;
		if (this.wordWrap) {
			const gutterWidth = this.showLineNumbers ? 52 : 0;
			const cellWidth = Math.max(1, (this.viewportWidth - this.overviewRuler.width) / 2 - gutterWidth - 1);
			const fontInfo = this.fontInfo ??= FontMeasurements.readFontInfo(getWindow(this.element), this.bareFontInfo);
			wrapping = { fontInfo, column: Math.max(1, Math.floor(cellWidth / fontInfo.typicalHalfwidthCharacterWidth)) };
		}
		const layout = computeDiffRowLayout(this.model, this.lineHeight, wrapping);
		this.rowOffsets = layout.offsets;
		this.wrappedRows = layout.wrappedRows;
	}
}

function diffRowLocation(row: LineDiffRow): string {
	const original = row.originalLineIndex === undefined ? "no original line" : `original line ${row.originalLineIndex + 1}`;
	const modified = row.modifiedLineIndex === undefined ? "no modified line" : `modified line ${row.modifiedLineIndex + 1}`;
	return `${original}, ${modified}`;
}

function validateOptions(options: DiffEditorWidgetOptions): void {
	if (!options || typeof options !== "object" || !isHTMLElement(options.container)) {
		throw new TypeError("Diff editor widget requires a browser container");
	}
	if (!options.model || typeof options.model !== "object") {
		throw new TypeError("Diff editor widget requires a diff model");
	}
	const lineHeight = options.lineHeight ?? DEFAULT_LINE_HEIGHT;
	const overscanRowCount = options.overscanRowCount ?? DEFAULT_OVERSCAN_ROW_COUNT;
	if (!isFiniteNumber(lineHeight) || lineHeight <= 0) throw new RangeError("Diff editor widget line height must be positive and finite");
	if (options.fontFamily !== undefined && (typeof options.fontFamily !== "string" || !options.fontFamily.trim())) throw new TypeError("Diff editor font family must be a non-empty string");
	if (options.fontSize !== undefined && (!isFiniteNumber(options.fontSize) || options.fontSize <= 0)) throw new RangeError("Diff editor font size must be positive and finite");
	for (const [name, value] of [
		["fontLigatures", options.fontLigatures],
		["showLineNumbers", options.showLineNumbers],
		["showInlineChanges", options.showInlineChanges],
		["loopChanges", options.loopChanges],
		["wordWrap", options.wordWrap],
	] as const) {
		if (value !== undefined && typeof value !== "boolean") throw new TypeError(`Diff editor option '${name}' must be boolean`);
	}
	if (!isNonNegativeSafeInteger(overscanRowCount)) throw new RangeError("Diff editor widget overscan row count must be a non-negative safe integer");
	const ownerWindow = getWindow(options.container);
	if (options.container.ownerDocument.defaultView !== ownerWindow) throw new Error("Diff editor widget container must belong to its owner window");
}
