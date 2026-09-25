import './style.css';
import { addDisposableListener, getClientArea, getWindow, h, isHTMLElement, stopEvent } from '../../../../base/browser/dom.js';
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
import { ScrollType, type IEditorDecorationsCollection } from '../../../common/editorCommon.js';
import { type IModelDeltaDecoration } from '../../../common/model.js';
import { type IDiffEditor, type IViewZoneChangeAccessor } from '../../editorBrowser.js';
import { ICodeEditorService } from '../../services/codeEditorService.js';
import { CodeEditorWidget, type CodeEditorWidgetOptions } from '../codeEditor/codeEditorWidget.js';
import { OverviewRulerFeature } from './features/overviewRulerFeature.js';
import { HideUnchangedRegionsFeature } from './features/hideUnchangedRegionsFeature.js';

const DEFAULT_LINE_HEIGHT = 20;
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
	readonly originalAriaLabel?: string;
	readonly modifiedAriaLabel?: string;
	readonly wordWrap?: boolean;
	readonly readOnly?: boolean;
	readonly scrollBeyondLastLine?: boolean;
	readonly hideUnchangedRegions?: HideUnchangedRegionsOptions;
	readonly renderSideBySide?: boolean;
	readonly useInlineViewWhenSpaceIsLimited?: boolean;
}

/** Owns two editor views over caller-owned source models and one versioned diff. */
export class DiffEditorWidget extends Disposable implements IDiffEditor {
	public readonly element: HTMLDivElement;
	public readonly originalEditor: CodeEditorWidget;
	public readonly modifiedEditor: CodeEditorWidget;
	private readonly id = `ash-diff-editor-${++diffEditorId}`;
	private readonly model: DiffModel;
	private readonly originalContainer: HTMLDivElement;
	private readonly modifiedContainer: HTMLDivElement;
	private readonly accessibilityStatusElement: HTMLDivElement;
	private readonly incompleteStatusElement: HTMLDivElement;
	private readonly originalDecorations: IEditorDecorationsCollection;
	private readonly modifiedDecorations: IEditorDecorationsCollection;
	private readonly overviewRuler: OverviewRulerFeature;
	private readonly hiddenRegions: HideUnchangedRegionsFeature;
	private readonly lineHeight: number;
	private readonly showInlineChanges: boolean;
	private readonly loopChanges: boolean;
	private readonly originalLabel: string;
	private readonly modifiedLabel: string;
	private configuredWordWrap: boolean;
	private temporaryWordWrap: boolean | undefined;
	private renderSideBySide: boolean;
	private useInlineViewWhenSpaceIsLimited: boolean;
	private inlineView = false;
	private activeChangeRow = -1;
	private viewportWidth = 0;
	private viewportHeight = 0;
	private syncingScroll = false;
	private originalZones: string[] = [];
	private modifiedZones: string[] = [];

	constructor(
		options: DiffEditorWidgetOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
	) {
		super();
		validateOptions(options);
		this.codeEditorService.willCreateDiffEditor();
		this.model = options.model;
		this.lineHeight = options.lineHeight ?? DEFAULT_LINE_HEIGHT;
		this.showInlineChanges = options.showInlineChanges ?? true;
		this.loopChanges = options.loopChanges ?? true;
		this.configuredWordWrap = options.wordWrap ?? false;
		this.renderSideBySide = options.renderSideBySide ?? true;
		this.useInlineViewWhenSpaceIsLimited = options.useInlineViewWhenSpaceIsLimited ?? false;
		this.originalLabel = options.originalAriaLabel ?? localize('diffEditor.original', 'Original');
		this.modifiedLabel = options.modifiedAriaLabel ?? localize('diffEditor.modified', 'Modified');
		const ownerDocument = options.container.ownerDocument;
		this.element = h(ownerDocument, 'div');
		this.element.className = 'stanza-diff-editor';
		this.element.classList.toggle('word-wrapped', this.wordWrap);
		this.element.tabIndex = 0;
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('diffEditor.ariaLabel', 'Diff editor: {0} and {1}', this.originalLabel, this.modifiedLabel));
		this.originalContainer = h(ownerDocument, 'div');
		this.originalContainer.className = 'stanza-diff-editor-side original';
		this.modifiedContainer = h(ownerDocument, 'div');
		this.modifiedContainer.className = 'stanza-diff-editor-side modified';
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
		this.originalDecorations = this.originalEditor.createDecorationsCollection();
		this.modifiedDecorations = this.modifiedEditor.createDecorationsCollection();
		this._register(toDisposable(() => {
			this.originalDecorations.clear();
			this.modifiedDecorations.clear();
		}));
		this.overviewRuler = this._register(new OverviewRulerFeature(this.element));
		this.hiddenRegions = this._register(new HideUnchangedRegionsFeature(
			this.originalEditor,
			this.modifiedEditor,
			this.model,
			options.hideUnchangedRegions ?? diffEditorDefaultOptions.hideUnchangedRegions,
			instantiationService,
		));
		this._register(addDisposableListener(this.element, 'scroll', event => {
			if (this.originalEditor.getDomNode().contains(event.target as Node)) this.synchronizeScroll(this.originalEditor, this.modifiedEditor);
			else if (this.modifiedEditor.getDomNode().contains(event.target as Node)) this.synchronizeScroll(this.modifiedEditor, this.originalEditor);
		}, true));
		this._register(addDisposableListener(this.element, 'keydown', event => this.handleKeydown(event), true));
		this._register(this.model.onDidChange(() => this.refresh()));
		this._register(onDidChangeNls(() => this.updateIncompleteStatus()));
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
		return this.temporaryWordWrap ?? this.configuredWordWrap;
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

	public setConfiguredWordWrap(enabled: boolean): void {
		this.configuredWordWrap = enabled;
		this.updateWordWrap();
	}

	public setHideUnchangedRegionsOptions(options: HideUnchangedRegionsOptions): void {
		this.hiddenRegions.setOptions(options);
	}

	public setViewMode(renderSideBySide: boolean, useInlineViewWhenSpaceIsLimited: boolean): void {
		this.renderSideBySide = renderSideBySide;
		this.useInlineViewWhenSpaceIsLimited = useInlineViewWhenSpaceIsLimited;
		this.layout({ width: this.viewportWidth, height: this.viewportHeight });
	}

	public toggleWordWrap(): void {
		this.temporaryWordWrap = this.temporaryWordWrap === undefined ? !this.wordWrap : undefined;
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
		const inlineView = !this.renderSideBySide || this.useInlineViewWhenSpaceIsLimited && size.width < 600;
		if (inlineView !== this.inlineView) {
			this.inlineView = inlineView;
			this.element.classList.toggle('inline-view', inlineView);
			this.originalContainer.setAttribute('aria-hidden', String(inlineView));
			if (inlineView && this.originalContainer.contains(this.element.ownerDocument.activeElement)) this.modifiedEditor.focus();
		}
		const editorWidth = Math.max(0, (size.width - this.overviewRuler.width) / (inlineView ? 1 : 2));
		this.originalEditor.layout({ width: editorWidth, height: size.height });
		this.modifiedEditor.layout({ width: editorWidth, height: size.height });
		this.updateZones();
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
		this.updateDecorations();
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
		this.updateDecorations();
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
		this.updateZones();
		this.updateDecorations();
		this.overviewRuler.setRows(this.model.diff?.rows ?? []);
		this.updateOverview();
	}

	private updateIncompleteStatus(): void {
		this.incompleteStatusElement.hidden = this.model.state.kind !== 'ready' || !this.model.state.quitEarly;
		this.incompleteStatusElement.textContent = this.incompleteStatusElement.hidden
			? ''
			: localize('diffEditor.incomplete', 'Diff computation stopped after the time limit. Results may be incomplete.');
	}

	private updateZones(): void {
		if (this.inlineView) {
			this.originalEditor.changeViewZones(accessor => {
				for (const id of this.originalZones) accessor.removeZone(id);
				this.originalZones = [];
			});
			this.modifiedEditor.changeViewZones(accessor => {
				for (const id of this.modifiedZones) accessor.removeZone(id);
				this.modifiedZones = [];
				let precedingModifiedLine = 0;
				for (const [ordinal, row] of (this.model.diff?.rows ?? []).entries()) {
					if (row.kind !== LineDiffKind.Unchanged && row.originalLineIndex !== undefined) {
						const line = h(this.element.ownerDocument, 'div');
						line.className = 'stanza-diff-inline-original-line';
						line.textContent = this.model.original.getLineContent(row.originalLineIndex + 1);
						line.setAttribute('aria-label', localize('diffEditor.removedLine', 'Removed line {0}: {1}', row.originalLineIndex + 1, line.textContent));
						this.modifiedZones.push(accessor.addZone({
							afterLineNumber: row.modifiedLineIndex ?? precedingModifiedLine,
							heightInPx: this.lineHeight,
							ordinal,
							domNode: line,
							isAccessible: true,
						}));
					}
					if (row.modifiedLineIndex !== undefined) precedingModifiedLine = row.modifiedLineIndex + 1;
				}
			});
			return;
		}
		const original: DiffViewZone[] = [];
		const modified: DiffViewZone[] = [];
		let originalAfterLineNumber = 0;
		let modifiedAfterLineNumber = 0;
		for (const [rowIndex, row] of (this.model.diff?.rows ?? []).entries()) {
			if (row.originalLineIndex !== undefined) originalAfterLineNumber = row.originalLineIndex + 1;
			if (row.modifiedLineIndex !== undefined) modifiedAfterLineNumber = row.modifiedLineIndex + 1;
			if (row.kind === LineDiffKind.Unchanged) continue;
			const originalHeight = row.originalLineIndex === undefined ? 0 : this.lineHeightFor(this.originalEditor, row.originalLineIndex + 1);
			const modifiedHeight = row.modifiedLineIndex === undefined ? 0 : this.lineHeightFor(this.modifiedEditor, row.modifiedLineIndex + 1);
			const rowHeight = Math.max(originalHeight, modifiedHeight);
			this.appendViewZone(original, originalAfterLineNumber, rowHeight - originalHeight, rowIndex);
			this.appendViewZone(modified, modifiedAfterLineNumber, rowHeight - modifiedHeight, rowIndex);
		}
		this.originalEditor.changeViewZones(accessor => {
			for (const id of this.originalZones) accessor.removeZone(id);
			this.originalZones = this.addViewZones(accessor, original);
		});
		this.modifiedEditor.changeViewZones(accessor => {
			for (const id of this.modifiedZones) accessor.removeZone(id);
			this.modifiedZones = this.addViewZones(accessor, modified);
		});
	}

	private lineHeightFor(editor: CodeEditorWidget, lineNumber: number): number {
		return this.wordWrap ? editor.getBottomForLineNumber(lineNumber) - editor.getTopForLineNumber(lineNumber) : this.lineHeight;
	}

	private appendViewZone(zones: DiffViewZone[], afterLineNumber: number, heightInPx: number, ordinal: number): void {
		if (heightInPx <= 0) return;
		const previous = zones.at(-1);
		if (previous?.afterLineNumber === afterLineNumber) {
			zones[zones.length - 1] = { ...previous, heightInPx: previous.heightInPx + heightInPx };
		} else {
			zones.push({ afterLineNumber, heightInPx, ordinal });
		}
	}

	private addViewZones(accessor: IViewZoneChangeAccessor, zones: readonly DiffViewZone[]): string[] {
		return zones.map(zone => accessor.addZone({ ...zone, domNode: h(this.element.ownerDocument, 'div') }));
	}

	private updateDecorations(): void {
		const original: IModelDeltaDecoration[] = [];
		const modified: IModelDeltaDecoration[] = [];
		for (const [rowIndex, row] of (this.model.diff?.rows ?? []).entries()) {
			if (row.kind === LineDiffKind.Unchanged) continue;
			const activeClass = rowIndex === this.activeChangeRow ? ' stanza-diff-line-active' : '';
			if (row.originalLineIndex !== undefined) {
				original.push({
					range: new Range(row.originalLineIndex + 1, 1, row.originalLineIndex + 1, 1),
					options: { description: 'diff-original-line', isWholeLine: true, className: `stanza-diff-line-removed${activeClass}` },
				});
				this.addInlineDecorations(original, row.originalLineIndex + 1, row.originalChanges, 'stanza-diff-inline-removed');
			}
			if (row.modifiedLineIndex !== undefined) {
				modified.push({
					range: new Range(row.modifiedLineIndex + 1, 1, row.modifiedLineIndex + 1, 1),
					options: { description: 'diff-modified-line', isWholeLine: true, className: `stanza-diff-line-added${activeClass}` },
				});
				this.addInlineDecorations(modified, row.modifiedLineIndex + 1, row.modifiedChanges, 'stanza-diff-inline-added');
			}
		}
		this.originalDecorations.set(original);
		this.modifiedDecorations.set(modified);
	}

	private addInlineDecorations(target: IModelDeltaDecoration[], lineNumber: number, changes: LineDiffRow['originalChanges'], className: string): void {
		if (!this.showInlineChanges) return;
		for (const change of changes) {
			if (change.startColumn === change.endColumn) continue;
			target.push({
				range: new Range(lineNumber, change.startColumn + 1, lineNumber, change.endColumn + 1),
				options: { description: 'diff-inline-change', inlineClassName: className },
			});
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
		if (event.shiftKey) this.previousChange();
		else this.nextChange();
	}
}

interface DiffViewZone {
	readonly afterLineNumber: number;
	readonly heightInPx: number;
	readonly ordinal: number;
}

function validateOptions(options: DiffEditorWidgetOptions): void {
	if (!options || typeof options !== 'object' || !isHTMLElement(options.container)) {
		throw new TypeError('Diff editor widget requires a browser container');
	}
	if (!options.model || typeof options.model !== 'object') throw new TypeError('Diff editor widget requires a diff model');
	if (!isFiniteNumber(options.lineHeight ?? DEFAULT_LINE_HEIGHT) || (options.lineHeight ?? DEFAULT_LINE_HEIGHT) <= 0) {
		throw new RangeError('Diff editor widget line height must be positive and finite');
	}
	if (options.fontFamily !== undefined && (typeof options.fontFamily !== 'string' || !options.fontFamily.trim())) {
		throw new TypeError('Diff editor font family must be a non-empty string');
	}
	if (options.fontSize !== undefined && (!isFiniteNumber(options.fontSize) || options.fontSize <= 0)) {
		throw new RangeError('Diff editor font size must be positive and finite');
	}
	for (const [name, value] of [
		['fontLigatures', options.fontLigatures],
		['showLineNumbers', options.showLineNumbers],
		['showInlineChanges', options.showInlineChanges],
		['loopChanges', options.loopChanges],
		['wordWrap', options.wordWrap],
		['readOnly', options.readOnly],
		['scrollBeyondLastLine', options.scrollBeyondLastLine],
		['renderSideBySide', options.renderSideBySide],
		['useInlineViewWhenSpaceIsLimited', options.useInlineViewWhenSpaceIsLimited],
	] as const) {
		if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`Diff editor option '${name}' must be boolean`);
	}
	if (options.container.ownerDocument.defaultView !== getWindow(options.container)) {
		throw new Error('Diff editor widget container must belong to its owner window');
	}
}
