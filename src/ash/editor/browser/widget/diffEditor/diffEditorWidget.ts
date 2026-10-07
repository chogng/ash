import './style.css';
import { addDisposableListener, getClientArea, h, stopEvent } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isFiniteNumber, isNonNegativeSafeInteger, rot } from '../../../../base/common/numbers.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { type IDimension } from '../../../common/core/2d/dimension.js';
import { diffEditorDefaultOptions, type HideUnchangedRegionsOptions } from '../../../common/config/diffEditor.js';
import { Range } from '../../../common/core/range.js';
import { type DiffModel } from '../../../common/diff/diffModel.js';
import { LineDiffKind, toLineDiff, type LineDiff, type LineDiffRow } from '../../../common/diff/lineDiff.js';
import { LineRangeMapping, type RangeMapping } from '../../../common/diff/rangeMapping.js';
import type { MovedText } from '../../../common/diff/linesDiffComputer.js';
import { LineRange } from '../../../common/core/ranges/lineRange.js';
import { EditorOption, type IDiffEditorOptions } from '../../../common/config/editorOptions.js';
import { ScrollType, type IEditorDecorationsCollection } from '../../../common/editorCommon.js';
import { TrackedRangeStickiness } from '../../../common/model.js';
import { type IDiffEditor } from '../../editorBrowser.js';
import { ICodeEditorService } from '../../services/codeEditorService.js';
import { CodeEditorWidget, type CodeEditorWidgetOptions } from '../codeEditor/codeEditorWidget.js';
import { AccessibleDiffViewer } from './components/accessibleDiffViewer.js';
import { DiffEditorDecorations } from './components/diffEditorDecorations.js';
import { DiffEditorSash } from './components/diffEditorSash.js';
import { DiffEditorViewZones } from './components/diffEditorViewZones/diffEditorViewZones.js';
import { DiffEditorOptions, type DiffEditorWidgetOptions } from './diffEditorOptions.js';
import { OverviewRulerFeature } from './features/overviewRulerFeature.js';
import { HideUnchangedRegionsFeature } from './features/hideUnchangedRegionsFeature.js';
import { RevertButtonsFeature } from './features/revertButtonsFeature.js';
import { DiffEditorGutter } from './features/gutterFeature.js';
import { MovedBlocksLinesFeature } from './features/movedBlocksLinesFeature.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

let diffEditorId = 0;

/** Owns two editor views over caller-owned source models and one versioned diff. */
export class DiffEditorWidget extends Disposable implements IDiffEditor {
	public readonly element: HTMLDivElement;
	public readonly originalEditor: CodeEditorWidget;
	public readonly modifiedEditor: CodeEditorWidget;
	private readonly id = `ash-diff-editor-${++diffEditorId}`;
	private readonly model: DiffModel;
	private readonly diffOptions: DiffEditorOptions;
	private readonly originalContainer: HTMLDivElement;
	private readonly modifiedContainer: HTMLDivElement;
	private readonly accessibilityStatusElement: HTMLDivElement;
	private readonly incompleteStatusElement: HTMLDivElement;
	private readonly diffDecorations: DiffEditorDecorations;
	private readonly accessibleDiffViewer: AccessibleDiffViewer;
	private readonly diffViewZones: DiffEditorViewZones;
	private readonly overviewRuler: OverviewRulerFeature;
	private readonly sash: DiffEditorSash;
	private readonly hiddenRegions: HideUnchangedRegionsFeature;
	private readonly revertButtons: RevertButtonsFeature;
	private readonly gutter: DiffEditorGutter;
	private readonly movedBlocks: MovedBlocksLinesFeature;
	private readonly originalMoveAnchor: IEditorDecorationsCollection;
	private readonly modifiedMoveAnchor: IEditorDecorationsCollection;
	private movedTextToCompare: MovedText | undefined;
	private readonly showInlineChanges: boolean;
	private readonly loopChanges: boolean;
	private readonly originalLabel: string;
	private readonly modifiedLabel: string;
	private inlineView = false;
	private activeChangeRow = -1;
	private viewportWidth = 0;
	private viewportHeight = 0;
	private syncingScroll = false;
	private accessibilityHelpHintEnabled = false;

	constructor(
		options: DiffEditorWidgetOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		this.diffOptions = instantiationService.createInstance(DiffEditorOptions, options);
		this.codeEditorService.willCreateDiffEditor();
		this.model = options.model;
		this.showInlineChanges = options.showInlineChanges ?? true;
		this.loopChanges = options.loopChanges ?? true;
		this.originalLabel = options.originalAriaLabel ?? localize('diffEditor.original', 'Original');
		this.modifiedLabel = options.modifiedAriaLabel ?? localize('diffEditor.modified', 'Modified');
		const ownerDocument = options.container.ownerDocument;
		this.element = h(ownerDocument, 'div');
		this.element.className = 'stanza-diff-editor';
		this.element.classList.toggle('word-wrapped', this.wordWrap);
		this.element.tabIndex = 0;
		this.element.setAttribute('role', 'region');
		this.updateAccessibilityLabel();
		this.originalContainer = h(ownerDocument, 'div');
		this.originalContainer.className = 'stanza-diff-editor-side original';
		this.originalContainer.id = `${this.id}-original`;
		this.modifiedContainer = h(ownerDocument, 'div');
		this.modifiedContainer.className = 'stanza-diff-editor-side modified';
		this.modifiedContainer.id = `${this.id}-modified`;
		this.accessibilityStatusElement = h(ownerDocument, 'div');
		this.accessibilityStatusElement.className = 'stanza-diff-editor-accessibility-status';
		this.accessibilityStatusElement.setAttribute('aria-live', 'polite');
		this.accessibilityStatusElement.setAttribute('aria-atomic', 'true');
		this.incompleteStatusElement = h(ownerDocument, 'div');
		this.incompleteStatusElement.className = 'stanza-diff-editor-incomplete-status';
		this.incompleteStatusElement.setAttribute('role', 'status');
		this.incompleteStatusElement.setAttribute('aria-live', 'polite');
		this.element.append(this.originalContainer, this.modifiedContainer, this.incompleteStatusElement, this.accessibilityStatusElement);
		options.container.append(this.element);
		this._register(toDisposable(() => this.element.remove()));

		const editorOptions: Pick<CodeEditorWidgetOptions, 'contributions' | 'isSimpleWidget' | 'minimap' | 'lineHeight' | 'fontFamily' | 'fontSize' | 'fontLigatures' | 'lineNumbers' | 'wordWrap' | 'scrollBeyondLastLine'> = {
			contributions: [],
			isSimpleWidget: true,
			minimap: { enabled: false },
			lineHeight: options.lineHeight,
			fontFamily: options.fontFamily,
			fontSize: options.fontSize,
			fontLigatures: options.fontLigatures,
			lineNumbers: options.showLineNumbers === false ? 'off' : 'on',
			wordWrap: this.wordWrap ? 'on' : 'off',
			scrollBeyondLastLine: options.scrollBeyondLastLine ?? true,
		};
		this.originalEditor = this._register(instantiationService.createInstance(CodeEditorWidget, {
			...editorOptions,
			container: this.originalContainer,
			model: this.model.original,
			ariaLabel: this.originalLabel,
			readOnly: true,
		}));
		this.modifiedEditor = this._register(instantiationService.createInstance(CodeEditorWidget, {
			...editorOptions,
			container: this.modifiedContainer,
			model: this.model.modified,
			ariaLabel: this.modifiedLabel,
			readOnly: options.readOnly ?? false,
			glyphMargin: this.diffOptions.renderMarginRevertIcon && !options.readOnly,
		}));
		this.diffDecorations = this._register(new DiffEditorDecorations(this.originalEditor, this.modifiedEditor));
		this.originalMoveAnchor = this.originalEditor.createDecorationsCollection();
		this.modifiedMoveAnchor = this.modifiedEditor.createDecorationsCollection();
		this._register(toDisposable(() => { this.originalMoveAnchor.clear(); this.modifiedMoveAnchor.clear(); }));
		this.diffViewZones = this._register(instantiationService.createInstance(DiffEditorViewZones, this.originalEditor, this.modifiedEditor, this.model));
		this.overviewRuler = this._register(new OverviewRulerFeature(this.element, this.originalEditor, this.modifiedEditor));
		this.revertButtons = this._register(new RevertButtonsFeature(this.modifiedEditor, this.model, this));
		this.gutter = this._register(instantiationService.createInstance(DiffEditorGutter, this.element, this.modifiedEditor, this.model,
			() => { this.updateFeatures(); this.layout({ width: this.viewportWidth, height: this.viewportHeight }); }));
		this.movedBlocks = this._register(new MovedBlocksLinesFeature(this.element, this.model, this.originalEditor, this.modifiedEditor, move => {
			if (move) {
				this.compareMove(move);
			} else {
				this.exitCompareMove();
			}
		}));
		this.sash = this._register(new DiffEditorSash(
			this.element,
			this.diffOptions,
			this.originalContainer.id,
			this.modifiedContainer.id,
			() => this.layout({ width: this.viewportWidth, height: this.viewportHeight }),
		));
		this.hiddenRegions = this._register(new HideUnchangedRegionsFeature(
			this.originalEditor,
			this.modifiedEditor,
			this.model,
			options.hideUnchangedRegions ?? diffEditorDefaultOptions.hideUnchangedRegions,
			instantiationService,
		));
		this.accessibleDiffViewer = this._register(new AccessibleDiffViewer(
			this.element,
			this.model,
			() => this.displayedDiff,
			direction => direction > 0 ? this.nextChange() : this.previousChange(),
			visible => this.setAccessibleViewerVisible(visible),
			() => this.modifiedEditor.focus(),
		));
		// Synchronize committed editor positions; a captured DOM scroll precedes the editor's own update.
		this._register(this.originalEditor.onDidScrollChange(() => this.synchronizeScroll(this.originalEditor, this.modifiedEditor)));
		this._register(this.modifiedEditor.onDidScrollChange(() => this.synchronizeScroll(this.modifiedEditor, this.originalEditor)));
		this._register(addDisposableListener(this.element, 'keydown', event => this.handleKeydown(event), true));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'Escape' && !event.defaultPrevented && this.movedTextToCompare && !this.accessibleDiffViewer.isVisible) {
				stopEvent(event);
				this.exitCompareMove();
			}
		}));
		this._register(this.model.onDidChange(() => this.refresh()));
		this._register(this.modifiedEditor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.fontInfo)) {
				this.refresh();
			}
		}));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('diffEditor.renderIndicators')) {
				this.diffDecorations.update(this.displayedDiff?.rows ?? [], this.activeChangeRow, this.showInlineChanges, this.diffOptions.renderIndicators);
				this.layout({ width: this.viewportWidth, height: this.viewportHeight });
			}
			if (event.affectsConfiguration('diffEditor.renderMarginRevertIcon')
				|| event.affectsConfiguration('diffEditor.renderGutterMenu')
				|| event.affectsConfiguration('diffEditor.renderOverviewRuler')
				|| event.affectsConfiguration('diffEditor.experimental.showMoves')) {
				this.updateFeatures();
				this.layout({ width: this.viewportWidth, height: this.viewportHeight });
			}
		}));
		this._register(observeResize(this.element, ([entry]) => {
			if (entry) this.layout({ width: entry.contentRect.width, height: entry.contentRect.height });
		}));
		this.codeEditorService.addDiffEditor(this);
		this._register(toDisposable(() => this.codeEditorService.removeDiffEditor(this)));
		this.refresh();
		this.layout(getClientArea(this.element));
	}

	public getId(): string {
		return this.id;
	}

	public get diff(): LineDiff | undefined {
		return this.model.diff;
	}

	public get wordWrap(): boolean {
		return this.diffOptions.wordWrap;
	}

	private get displayedDiff(): LineDiff | undefined {
		const diff = this.model.diff;
		const move = this.movedTextToCompare;
		if (!diff || !move) {
			return diff;
		}
		return toLineDiff({ changes: move.changes, moves: [move] }, this.model.original.lineCount, this.model.modified.lineCount, move.lineRangeMapping);
	}

	private compareMove(move: MovedText): void {
		if (!this.model.diff?.moves.includes(move) || this.inlineView || !this.diffOptions.showMoves) {
			return;
		}
		this.accessibleDiffViewer.close();
		this.movedTextToCompare = move;
		this.trackComparedMove(move);
		this.refresh();
		const top = this.originalEditor.getTopForLineNumber(move.lineRangeMapping.original.startLineNumber);
		this.originalEditor.setScrollTop(top, ScrollType.Immediate);
		this.modifiedEditor.setScrollTop(top, ScrollType.Immediate);
		this.modifiedEditor.focus();
		const mapping = move.lineRangeMapping;
		this.modifiedEditor.announceAccessibilityStatus(localize('diffEditor.movedLines', 'Moved original lines {0}–{1} to modified lines {2}–{3}',
			mapping.original.startLineNumber, mapping.original.endLineNumberExclusive - 1,
			mapping.modified.startLineNumber, mapping.modified.endLineNumberExclusive - 1));
	}

	public exitCompareMove(): void {
		if (!this.movedTextToCompare) {
			return;
		}
		const line = this.modifiedMoveAnchor.getRange(0)?.startLineNumber;
		this.accessibleDiffViewer.close();
		this.clearComparedMove();
		this.refresh();
		if (line) {
			this.modifiedEditor.revealRange(new Range(line, 1, line, 1), ScrollType.Immediate);
		}
		this.modifiedEditor.focus();
		this.modifiedEditor.announceAccessibilityStatus(localize('diffEditor.stoppedComparingMovedCode', 'Returned to the full comparison'));
	}

	private trackComparedMove(move: MovedText): void {
		for (const [anchor, side] of [[this.originalMoveAnchor, 'original'], [this.modifiedMoveAnchor, 'modified']] as const) {
			anchor.set([{
				range: move.lineRangeMapping[side].toInclusiveRange()!,
				options: { description: 'diff-move-comparison-anchor', stickiness: TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges },
			}]);
		}
	}

	private clearComparedMove(): void {
		this.movedTextToCompare = undefined;
		this.originalMoveAnchor.clear();
		this.modifiedMoveAnchor.clear();
	}

	private get comparedRange(): LineRangeMapping | undefined {
		if (!this.movedTextToCompare) {
			return undefined;
		}
		const original = this.originalMoveAnchor.getRange(0)!;
		const modified = this.modifiedMoveAnchor.getRange(0)!;
		return new LineRangeMapping(LineRange.fromRangeInclusive(original), LineRange.fromRangeInclusive(modified));
	}

	public get currentChangeRow(): number {
		return this.activeChangeRow;
	}

	public get viewMode(): 'inline' | 'sideBySide' {
		return this.inlineView ? 'inline' : 'sideBySide';
	}

	public focus(): void {
		this.modifiedEditor.focus();
	}

	/** A control may outlive its result; only the current mapping can authorize an edit. */
	public revert(change: LineRangeMapping): void {
		if (!this.model.diff?.changes.some(current => current === change)
			|| this.movedTextToCompare || this.modifiedEditor.getOption(EditorOption.readOnly)) return;
		const target = change.modified;
		const lineCount = this.model.modified.getLineCount();
		const endsAtDocumentEnd = target.endLineNumberExclusive > lineCount;
		const includesPrecedingBreak = endsAtDocumentEnd && target.startLineNumber > 1;
		const startLine = includesPrecedingBreak ? target.startLineNumber - 1 : target.startLineNumber;
		const endLine = endsAtDocumentEnd ? lineCount : target.endLineNumberExclusive;
		const range = new Range(startLine, includesPrecedingBreak ? this.model.modified.getLineMaxColumn(startLine) : 1,
			endLine, endsAtDocumentEnd ? this.model.modified.getLineMaxColumn(endLine) : 1);
		const lines = this.model.original.getLinesContent().slice(change.original.startLineNumber - 1, change.original.endLineNumberExclusive - 1);
		const eol = this.model.modified.getEOL();
		let text = lines.join(eol);
		// At EOF the separator belongs to the preceding line; elsewhere it belongs to the replaced span.
		if (lines.length > 0) {
			if (includesPrecedingBreak) text = eol + text;
			else if (!endsAtDocumentEnd) text += eol;
		}
		this.modifiedEditor.pushUndoStop();
		this.modifiedEditor.executeEdits('diffEditor', [{ range, text }]);
		this.modifiedEditor.pushUndoStop();
		this.modifiedEditor.focus();
		this.modifiedEditor.announceAccessibilityStatus(localize('diffEditor.reverted', 'Change reverted'));
	}

	public revertRangeMappings(changes: RangeMapping[]): void {
		const diff = this.model.diff;
		if (!diff || this.movedTextToCompare || this.modifiedEditor.getOption(EditorOption.readOnly)) return;
		const current = new Set(diff.changes.flatMap(change => change.innerChanges ?? []));
		if (changes.length === 0 || changes.some(change => !current.has(change))) return;
		const edits = changes.map(change => ({ range: change.modifiedRange, text: this.model.original.getValueInRange(change.originalRange) }));
		this.modifiedEditor.pushUndoStop();
		this.modifiedEditor.executeEdits('diffEditor', edits);
		this.modifiedEditor.pushUndoStop();
		this.modifiedEditor.focus();
		this.modifiedEditor.announceAccessibilityStatus(localize('diffEditor.reverted', 'Change reverted'));
	}

	public hasFocus(): boolean {
		return this.element.contains(this.element.ownerDocument.activeElement);
	}

	public getAccessibleContent(): string {
		return this.accessibleDiffViewer.getAccessibleContent();
	}

	public accessibleDiffViewerNext(): void {
		this.accessibleDiffViewer.next();
	}

	public accessibleDiffViewerPrev(): void {
		this.accessibleDiffViewer.previous();
	}

	public setAccessibilityHelpHint(enabled: boolean): void {
		this.accessibilityHelpHintEnabled = enabled;
		this.updateAccessibilityLabel();
	}

	public setConfiguredWordWrap(enabled: boolean): void {
		this.diffOptions.setConfiguredWordWrap(enabled);
		this.updateWordWrap();
	}

	public setHideUnchangedRegionsOptions(options: HideUnchangedRegionsOptions): void {
		this.hiddenRegions.setOptions(options);
		this.layout({ width: this.viewportWidth, height: this.viewportHeight });
	}

	public updateOptions(options: IDiffEditorOptions): void {
		this.diffOptions.updateOptions(options);
		this.diffDecorations.update(this.displayedDiff?.rows ?? [], this.activeChangeRow, this.showInlineChanges, this.diffOptions.renderIndicators);
		if (options.readOnly !== undefined) this.modifiedEditor.updateOptions({ readOnly: options.readOnly });
		this.updateFeatures();
		this.layout({ width: this.viewportWidth, height: this.viewportHeight });
	}

	public setViewMode(renderSideBySide: boolean, useInlineViewWhenSpaceIsLimited: boolean, inlineBreakpoint: number): void {
		this.diffOptions.setViewMode(renderSideBySide, useInlineViewWhenSpaceIsLimited, inlineBreakpoint);
		this.layout({ width: this.viewportWidth, height: this.viewportHeight });
	}

	public setSplitViewOptions(enabled: boolean, defaultRatio: number): void {
		this.diffOptions.setSplitViewOptions(enabled, defaultRatio);
		this.layout({ width: this.viewportWidth, height: this.viewportHeight });
	}

	public toggleWordWrap(): void {
		this.diffOptions.toggleWordWrap();
		this.updateWordWrap();
		this.accessibilityStatusElement.textContent = this.wordWrap
			? localize('wordWrap.enabled', 'Word wrap on')
			: localize('wordWrap.disabled', 'Word wrap off');
	}

	public layout(size: IDimension = getClientArea(this.element)): void {
		if (!isFiniteNumber(size.width) || size.width < 0 || !isFiniteNumber(size.height) || size.height < 0) {
			throw new RangeError('Diff editor widget layout size must be finite and non-negative');
		}
		this.viewportWidth = size.width;
		this.viewportHeight = size.height;
		const inlineView = this.diffOptions.isInlineView(size.width);
		if (inlineView !== this.inlineView) {
			this.inlineView = inlineView;
			this.element.classList.toggle('inline-view', inlineView);
			this.originalContainer.setAttribute('aria-hidden', String(inlineView || this.accessibleDiffViewer.isVisible));
			if (inlineView && this.originalContainer.contains(this.element.ownerDocument.activeElement)) this.modifiedEditor.focus();
			if (inlineView && this.movedTextToCompare) {
				this.clearComparedMove();
				this.diffDecorations.update(this.model.diff?.rows ?? [], -1, this.showInlineChanges, this.diffOptions.renderIndicators);
				this.overviewRuler.setRows(this.model.diff?.rows ?? []);
			}
			this.updateFeatures();
		}
		const headerHeight = this.movedBlocks.headerHeight;
		const editorHeight = Math.max(0, size.height - headerHeight);
		const centerWidth = this.gutter.width + this.movedBlocks.width;
		const contentWidth = Math.max(0, size.width - this.overviewRuler.width - centerWidth);
		const sashHadFocus = this.sash.element === this.element.ownerDocument.activeElement;
		const originalWidth = this.sash.layout(contentWidth, editorHeight, inlineView, headerHeight);
		if (this.sash.element.hidden && sashHadFocus) this.modifiedEditor.focus();
		this.element.style.setProperty('--stanza-diff-original-width', `${originalWidth}px`);
		this.element.style.setProperty('--ash-diff-center-width', `${centerWidth}px`);
		this.element.style.setProperty('--ash-diff-overview-width', `${this.overviewRuler.width}px`);
		this.element.style.setProperty('--ash-diff-header-height', `${headerHeight}px`);
		this.originalEditor.layout({ width: inlineView ? contentWidth : originalWidth, height: editorHeight });
		this.modifiedEditor.layout({ width: inlineView ? contentWidth : contentWidth - originalWidth, height: editorHeight });
		this.diffViewZones.update(this.inlineView, this.wordWrap, this.displayedDiff?.rows ?? [], this.diffOptions.renderIndicators, this.comparedRange);
		this.gutter.layout(inlineView ? 0 : originalWidth, editorHeight);
		this.movedBlocks.layout(originalWidth + this.gutter.width, editorHeight);
		this.overviewRuler.layout({ width: size.width, height: editorHeight });
		this.updateOverview();
	}

	public revealOriginalLine(lineIndex: number): void {
		this.revealLine('originalLineIndex', lineIndex);
	}

	public revealModifiedLine(lineIndex: number): void {
		this.revealLine('modifiedLineIndex', lineIndex);
	}

	public nextChange(): number | undefined {
		return this.selectRelativeChange(1);
	}

	public previousChange(): number | undefined {
		return this.selectRelativeChange(-1);
	}

	/** Selects one changed row in this comparison; the caller may announce collection-wide navigation. */
	public revealChangeRow(rowIndex: number, announce = true): void {
		const rows = this.model.diff?.rows;
		if (!rows || !isNonNegativeSafeInteger(rowIndex) || rows[rowIndex]?.kind === LineDiffKind.Unchanged || !rows[rowIndex]) {
			throw new RangeError('Diff change row is outside the current result');
		}
		if (this.movedTextToCompare) {
			this.exitCompareMove();
		}
		this.revealDiffRow(rows, rowIndex, announce);
	}

	private revealDiffRow(rows: readonly LineDiffRow[], rowIndex: number, announce: boolean): void {
		this.activeChangeRow = rowIndex;
		this.diffDecorations.update(rows, this.activeChangeRow, this.showInlineChanges, this.diffOptions.renderIndicators);
		const row = rows[rowIndex];
		if (row.modifiedLineIndex !== undefined) {
			const lineNumber = row.modifiedLineIndex + 1;
			const column = (row.modifiedChanges[0]?.startColumn ?? 0) + 1;
			this.modifiedEditor.revealRange(new Range(lineNumber, column, lineNumber, column), ScrollType.Immediate);
		} else if (row.originalLineIndex !== undefined && !this.inlineView) {
			const lineNumber = row.originalLineIndex + 1;
			const column = (row.originalChanges[0]?.startColumn ?? 0) + 1;
			this.originalEditor.revealRange(new Range(lineNumber, column, lineNumber, column), ScrollType.Immediate);
		} else if (this.inlineView) {
			// A removed line lives in a zone after its preceding modified line, not at its original line number.
			let precedingRow = rowIndex - 1;
			while (precedingRow >= 0 && rows[precedingRow]!.modifiedLineIndex === undefined) {
				precedingRow--;
			}
			const precedingLine = rows[precedingRow]?.modifiedLineIndex;
			const top = precedingLine === undefined
				? this.modifiedEditor.getOption(EditorOption.padding).top
				: this.modifiedEditor.getBottomForLineNumber(precedingLine + 1);
			const zoneTop = top + (rowIndex - precedingRow - 1) * this.modifiedEditor.getOption(EditorOption.lineHeight);
			this.modifiedEditor.setScrollTop(Math.max(0, zoneTop - this.modifiedEditor.getLayoutInfo().height / 2), ScrollType.Immediate);
		}
		if (announce) {
			const changedRows = rows.flatMap((candidate, index) => candidate.kind === LineDiffKind.Unchanged ? [] : [index]);
			this.accessibilityStatusElement.textContent = localize(
				'diffEditor.changeLocation', 'Change {0} of {1}, {2}',
				changedRows.indexOf(rowIndex) + 1, changedRows.length, this.diffRowLocation(row),
			);
		}
	}

	public clearActiveChange(): void {
		if (this.activeChangeRow < 0) return;
		this.activeChangeRow = -1;
		this.diffDecorations.update(this.displayedDiff?.rows ?? [], this.activeChangeRow, this.showInlineChanges, this.diffOptions.renderIndicators);
	}

	private updateWordWrap(): void {
		this.element.classList.toggle('word-wrapped', this.wordWrap);
		const wordWrap = this.wordWrap ? 'on' : 'off';
		this.originalEditor.updateOptions({ wordWrap });
		this.modifiedEditor.updateOptions({ wordWrap });
		this.layout({ width: this.viewportWidth, height: this.viewportHeight });
	}

	private refresh(): void {
		this.activeChangeRow = -1;
		if (this.model.diff && this.movedTextToCompare) {
			const range = this.comparedRange!;
			const next = this.model.diff.moves.find(move => move.lineRangeMapping.original.intersect(range.original)?.isEmpty === false
				&& move.lineRangeMapping.modified.intersect(range.modified)?.isEmpty === false);
			if (next) {
				this.movedTextToCompare = next;
				this.trackComparedMove(next);
			} else {
				this.clearComparedMove();
			}
		}
		this.accessibilityStatusElement.textContent = this.model.state.kind === 'loading'
			? localize('diffEditor.computing', 'Computing differences')
			: this.model.state.kind === 'error'
				? localize('diffEditor.error', 'Could not compute differences: {0}', this.model.state.error.message)
				: '';
		this.updateIncompleteStatus();
		this.updateFeatures();
		this.diffDecorations.update(this.displayedDiff?.rows ?? [], this.activeChangeRow, this.showInlineChanges, this.diffOptions.renderIndicators);
		this.overviewRuler.setRows(this.displayedDiff?.rows ?? []);
		this.layout({ width: this.viewportWidth, height: this.viewportHeight });
	}

	private updateFeatures(): void {
		if (!this.diffOptions.showMoves && this.movedTextToCompare) {
			this.clearComparedMove();
			this.diffDecorations.update(this.model.diff?.rows ?? [], -1, this.showInlineChanges, this.diffOptions.renderIndicators);
			this.overviewRuler.setRows(this.model.diff?.rows ?? []);
		}
		this.gutter.update(this.diffOptions.renderGutterMenu && !this.movedTextToCompare);
		const marginEnabled = this.diffOptions.renderMarginRevertIcon && this.gutter.width === 0 && !this.movedTextToCompare;
		this.revertButtons.update(marginEnabled);
		this.modifiedEditor.updateOptions({ glyphMargin: marginEnabled && !this.modifiedEditor.getOption(EditorOption.readOnly) });
		this.movedBlocks.update(this.diffOptions.showMoves && !this.inlineView, this.movedTextToCompare);
		this.overviewRuler.setEnabled(this.diffOptions.renderOverviewRuler);
	}

	private updateIncompleteStatus(): void {
		this.incompleteStatusElement.hidden = this.model.state.kind !== 'ready' || !this.model.state.quitEarly;
		this.incompleteStatusElement.textContent = this.incompleteStatusElement.hidden
			? ''
			: localize('diffEditor.incomplete', 'Diff computation stopped after the time limit. Results may be incomplete.');
	}

	private setAccessibleViewerVisible(visible: boolean): void {
		this.element.classList.toggle('accessible-view-open', visible);
		this.originalContainer.setAttribute('aria-hidden', String(visible || this.inlineView));
		this.modifiedContainer.setAttribute('aria-hidden', String(visible));
		this.sash.element.setAttribute('aria-hidden', String(visible));
		this.originalContainer.inert = visible;
		this.modifiedContainer.inert = visible;
		this.sash.element.inert = visible;
		this.element.classList.toggle('features-inert', visible);
	}

	private updateAccessibilityLabel(): void {
		this.element.setAttribute('aria-label', localize('diffEditor.ariaLabel', 'Diff editor: {0} and {1}', this.originalLabel, this.modifiedLabel));
		if (this.accessibilityHelpHintEnabled) {
			this.element.setAttribute('aria-description', localize('accessibility.openHelpHint', 'Press Alt+F1 for accessibility help.'));
		} else {
			this.element.removeAttribute('aria-description');
		}
	}

	private revealLine(side: 'originalLineIndex' | 'modifiedLineIndex', lineIndex: number): void {
		if (!isNonNegativeSafeInteger(lineIndex)) throw new RangeError('Diff line index must be a non-negative safe integer');
		const diff = this.model.diff;
		if (!diff) throw new Error('Diff results are not ready');
		const rowIndex = diff.rows.findIndex(row => row[side] === lineIndex);
		if (rowIndex < 0) throw new RangeError('Diff line index is outside its source model');
		const editor = side === 'originalLineIndex' ? this.originalEditor : this.modifiedEditor;
		editor.revealRange(new Range(lineIndex + 1, 1, lineIndex + 1, 1), ScrollType.Immediate);
	}

	private selectRelativeChange(delta: -1 | 1): number | undefined {
		const diff = this.displayedDiff;
		if (!diff) {
			this.accessibilityStatusElement.textContent = localize('diffEditor.computing', 'Computing differences');
			return undefined;
		}
		const changedRows = diff.rows.flatMap((row, index) => row.kind === LineDiffKind.Unchanged ? [] : [index]);
		if (changedRows.length === 0) {
			this.accessibilityStatusElement.textContent = localize('diffEditor.noChanges', 'No differences');
			return undefined;
		}
		const currentIndex = changedRows.indexOf(this.activeChangeRow);
		const selectedIndex = currentIndex < 0
			? delta > 0 ? 0 : changedRows.length - 1
			: this.loopChanges
				? rot(currentIndex + delta, changedRows.length)
				: Math.max(0, Math.min(changedRows.length - 1, currentIndex + delta));
		const rowIndex = changedRows[selectedIndex]!;
		this.revealDiffRow(diff.rows, rowIndex, true);
		return rowIndex;
	}

	private diffRowLocation(row: LineDiffRow): string {
		const original = row.originalLineIndex === undefined
			? localize('diffEditor.noOriginalLine', 'no original line')
			: localize('diffEditor.originalLine', 'original line {0}', row.originalLineIndex + 1);
		const modified = row.modifiedLineIndex === undefined
			? localize('diffEditor.noModifiedLine', 'no modified line')
			: localize('diffEditor.modifiedLine', 'modified line {0}', row.modifiedLineIndex + 1);
		return `${original}, ${modified}`;
	}

	private synchronizeScroll(source: CodeEditorWidget, target: CodeEditorWidget): void {
		if (this.syncingScroll) return;
		const top = source.getScrollTop();
		if (target.getScrollTop() !== top) {
			this.syncingScroll = true;
			try {
				target.setScrollTop(top);
			} finally {
				this.syncingScroll = false;
			}
		}
		this.updateOverview();
		this.gutter.layout(this.inlineView ? 0 : this.sash.left, Math.max(0, this.viewportHeight - this.movedBlocks.headerHeight));
	}

	private updateOverview(): void {
		this.overviewRuler.updateViewport(this.modifiedEditor.getContentHeight(), this.modifiedEditor.getScrollTop());
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState('AltGraph')) return;
		if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'z') {
			stopEvent(event);
			this.toggleWordWrap();
			return;
		}
		if (event.key !== 'F7' || event.ctrlKey || event.metaKey || event.altKey) return;
		stopEvent(event);
		if (event.shiftKey) this.accessibleDiffViewerPrev();
		else this.accessibleDiffViewerNext();
	}
}
