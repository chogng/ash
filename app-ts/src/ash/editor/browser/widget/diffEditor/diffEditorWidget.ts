import './style.css';
import { addDisposableListener, getClientArea, h, stopEvent } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isFiniteNumber, isNonNegativeSafeInteger, rot } from '../../../../base/common/numbers.js';
import { localize, onDidChangeNls } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { type IDimension } from '../../../common/core/2d/dimension.js';
import { diffEditorDefaultOptions, type HideUnchangedRegionsOptions } from '../../../common/config/diffEditor.js';
import { Range } from '../../../common/core/range.js';
import { type DiffModel } from '../../../common/diff/diffModel.js';
import { LineDiffKind, type LineDiff, type LineDiffRow } from '../../../common/diff/lineDiff.js';
import { ScrollType } from '../../../common/editorCommon.js';
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

const DEFAULT_LINE_HEIGHT = 20;
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
	private readonly lineHeight: number;
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
	) {
		super();
		this.diffOptions = new DiffEditorOptions(options);
		this.codeEditorService.willCreateDiffEditor();
		this.model = options.model;
		this.lineHeight = options.lineHeight ?? DEFAULT_LINE_HEIGHT;
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
			lineHeight: this.lineHeight,
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
		}));
		this.diffDecorations = this._register(new DiffEditorDecorations(this.originalEditor, this.modifiedEditor));
		this.diffViewZones = this._register(new DiffEditorViewZones(this.originalEditor, this.modifiedEditor, this.model, this.lineHeight));
		this.overviewRuler = this._register(new OverviewRulerFeature(this.element));
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
			direction => direction > 0 ? this.nextChange() : this.previousChange(),
			visible => this.setAccessibleViewerVisible(visible),
			() => this.modifiedEditor.focus(),
		));
		this._register(addDisposableListener(this.element, 'scroll', event => {
			if (this.originalEditor.getDomNode().contains(event.target as Node)) this.synchronizeScroll(this.originalEditor, this.modifiedEditor);
			else if (this.modifiedEditor.getDomNode().contains(event.target as Node)) this.synchronizeScroll(this.modifiedEditor, this.originalEditor);
		}, true));
		this._register(addDisposableListener(this.element, 'keydown', event => this.handleKeydown(event), true));
		this._register(this.model.onDidChange(() => this.refresh()));
		this._register(onDidChangeNls(() => {
			this.updateIncompleteStatus();
			this.updateAccessibilityLabel();
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

	public get currentChangeRow(): number {
		return this.activeChangeRow;
	}

	public get viewMode(): 'inline' | 'sideBySide' {
		return this.inlineView ? 'inline' : 'sideBySide';
	}

	public focus(): void {
		this.modifiedEditor.focus();
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
		}
		const contentWidth = Math.max(0, size.width - this.overviewRuler.width);
		const sashHadFocus = this.sash.element === this.element.ownerDocument.activeElement;
		const originalWidth = this.sash.layout(contentWidth, size.height, inlineView);
		if (this.sash.element.hidden && sashHadFocus) this.modifiedEditor.focus();
		this.element.style.setProperty('--stanza-diff-original-width', `${originalWidth}px`);
		this.originalEditor.layout({ width: inlineView ? contentWidth : originalWidth, height: size.height });
		this.modifiedEditor.layout({ width: inlineView ? contentWidth : contentWidth - originalWidth, height: size.height });
		this.diffViewZones.update(this.inlineView, this.wordWrap);
		this.overviewRuler.layout(size);
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
		this.activeChangeRow = rowIndex;
		this.diffDecorations.update(rows, this.activeChangeRow, this.showInlineChanges);
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
			const lineNumber = Math.min(this.model.modified.getLineCount(), Math.max(1, (row.originalLineIndex ?? 0) + 1));
			this.modifiedEditor.revealRange(new Range(lineNumber, 1, lineNumber, 1), ScrollType.Immediate);
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
		this.diffDecorations.update(this.model.diff?.rows ?? [], this.activeChangeRow, this.showInlineChanges);
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
		this.accessibilityStatusElement.textContent = this.model.state.kind === 'loading'
			? localize('diffEditor.computing', 'Computing differences')
			: this.model.state.kind === 'error'
				? localize('diffEditor.error', 'Could not compute differences: {0}', this.model.state.error.message)
				: '';
		this.updateIncompleteStatus();
		this.diffViewZones.update(this.inlineView, this.wordWrap);
		this.diffDecorations.update(this.model.diff?.rows ?? [], this.activeChangeRow, this.showInlineChanges);
		this.overviewRuler.setRows(this.model.diff?.rows ?? []);
		this.updateOverview();
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
		const diff = this.model.diff;
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
		this.revealChangeRow(rowIndex);
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
