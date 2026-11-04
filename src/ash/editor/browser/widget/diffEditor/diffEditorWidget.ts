import './style.css';
import { addDisposableListener, getClientArea, h, stopEvent } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { isFiniteNumber, isNonNegativeSafeInteger, rot } from '../../../../base/common/numbers.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { type IDimension } from '../../../common/core/2d/dimension.js';
import { diffEditorDefaultOptions, type HideUnchangedRegionsOptions } from '../../../common/config/diffEditor.js';
import { Range } from '../../../common/core/range.js';
import { type DiffModel } from '../../../common/diff/diffModel.js';
import { StableEditorBottomScrollState, StableEditorScrollState } from '../../stableEditorScroll.js';
import { LineDiffKind, LineDiffRows, type LineDiff, type LineDiffRow } from '../../../common/diff/lineDiff.js';
import { LineRangeMapping, type RangeMapping } from '../../../common/diff/rangeMapping.js';
import type { MovedText } from '../../../common/diff/linesDiffComputer.js';
import { LineRange } from '../../../common/core/ranges/lineRange.js';
import { EditorOption, type IDiffEditorOptions, type IEditorOptions } from '../../../common/config/editorOptions.js';
import { ScrollType, type IContentSizeChangedEvent } from '../../../common/editorCommon.js';
import { type ICodeEditor, type IDiffEditor } from '../../editorBrowser.js';
import { ICodeEditorService } from '../../services/codeEditorService.js';
import { type CodeEditorWidget } from '../codeEditor/codeEditorWidget.js';
import { AccessibleDiffViewer } from './components/accessibleDiffViewer.js';
import { DiffEditorDecorations } from './components/diffEditorDecorations.js';
import { DiffEditorSash } from './components/diffEditorSash.js';
import { DiffEditorEditors } from './components/diffEditorEditors.js';
import { DiffEditorViewZones } from './components/diffEditorViewZones/diffEditorViewZones.js';
import { DiffEditorOptions, type DiffEditorWidgetOptions } from './diffEditorOptions.js';
import { DiffEditorViewModel } from './diffEditorViewModel.js';
import { DelegatingEditor } from './delegatingEditorImpl.js';
import { AccessibilitySignal, IAccessibilitySignalService } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { OverviewRulerFeature } from './features/overviewRulerFeature.js';
import { HideUnchangedRegionsFeature } from './features/hideUnchangedRegionsFeature.js';
import { RevertButtonsFeature } from './features/revertButtonsFeature.js';
import { DiffEditorGutter } from './features/gutterFeature.js';
import { MovedBlocksLinesFeature } from './features/movedBlocksLinesFeature.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

interface DiffEditorModelBinding {
	readonly model: DiffModel;
	readonly diffDecorations: DiffEditorDecorations;
	readonly viewModel: DiffEditorViewModel;
	readonly diffViewZones: DiffEditorViewZones;
	readonly overviewRuler: OverviewRulerFeature;
	readonly revertButtons: RevertButtonsFeature;
	readonly gutter: DiffEditorGutter;
	readonly movedBlocks: MovedBlocksLinesFeature;
	readonly sash: DiffEditorSash;
	readonly hiddenRegions: HideUnchangedRegionsFeature;
	readonly accessibleDiffViewer: AccessibleDiffViewer;
}

let diffEditorId = 0;

/** Owns two editor views over caller-owned source models and one versioned diff. */
export class DiffEditorWidget extends DelegatingEditor implements IDiffEditor {
	private readonly contentSizeEmitter = this._register(new Emitter<IContentSizeChangedEvent>());
	public readonly onDidContentSizeChange = this.contentSizeEmitter.event;
	private reportedContentWidth = 0;
	private reportedContentHeight = 0;
	public readonly element: HTMLDivElement;
	public readonly originalEditor: CodeEditorWidget;
	public readonly modifiedEditor: CodeEditorWidget;
	private readonly editors: DiffEditorEditors;
	private readonly id = `ash-diff-editor-${++diffEditorId}`;
	private readonly modelResources: DisposableStore;
	private modelBinding: DiffEditorModelBinding | undefined;
	private changingModel = false;
	private hideUnchangedRegionsOptions: HideUnchangedRegionsOptions;
	private readonly diffOptions: DiffEditorOptions;
	private readonly originalContainer: HTMLDivElement;
	private readonly modifiedContainer: HTMLDivElement;
	private readonly accessibilityStatusElement: HTMLDivElement;
	private readonly incompleteStatusElement: HTMLDivElement;
	private showInlineChanges: boolean;
	private loopChanges: boolean;
	private originalLabel: string;
	private modifiedLabel: string;
	private inlineView = false;
	private activeChangeRow = -1;
	private viewportWidth = 0;
	private viewportHeight = 0;
	private syncingScroll = false;
	private accessibilityHelpHintEnabled = false;
	private configuredGlyphMargin: boolean;
	private modifiedLineNumbersMinChars: number;

	constructor(
		options: DiffEditorWidgetOptions,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IConfigurationService configuration: IConfigurationService,
		@IAccessibilitySignalService private readonly signals: IAccessibilitySignalService,
	) {
		super();
		this.diffOptions = instantiationService.createInstance(DiffEditorOptions, options);
		this.codeEditorService.willCreateDiffEditor();
		this.hideUnchangedRegionsOptions = options.hideUnchangedRegions ?? diffEditorDefaultOptions.hideUnchangedRegions;
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

		this.editors = this._register(instantiationService.createInstance(DiffEditorEditors, this.originalContainer, this.modifiedContainer, {
			...options,
			wordWrap: this.diffOptions.wordWrap,
			originalAriaLabel: this.originalLabel,
			modifiedAriaLabel: this.modifiedLabel,
			renderMarginRevertIcon: this.diffOptions.renderMarginRevertIcon,
		}));
		this.originalEditor = this.editors.original;
		this.modifiedEditor = this.editors.modified;
		// Dispose the binding before its persistent editor pair (stores unwind in reverse order).
		this.modelResources = this._register(new DisposableStore());
		this._register(toDisposable(() => { this.modelBinding = undefined; }));
		this.configuredGlyphMargin = this.originalEditor.getOption(EditorOption.glyphMargin);
		this.modifiedLineNumbersMinChars = this.modifiedEditor.getOption(EditorOption.lineNumbersMinChars);
		// Synchronize committed editor positions; a captured DOM scroll precedes the editor's own update.
		this._register(this.originalEditor.onDidScrollChange(() => this.synchronizeScroll(this.originalEditor, this.modifiedEditor)));
		this._register(this.modifiedEditor.onDidScrollChange(() => this.synchronizeScroll(this.modifiedEditor, this.originalEditor)));
		this._register(this.originalEditor.onDidLayoutChange(() => this.updateContentSize()));
		this._register(this.modifiedEditor.onDidLayoutChange(() => this.updateContentSize()));
		this._register(this.originalEditor.onDidContentSizeChange(() => this.updateContentSize()));
		this._register(this.modifiedEditor.onDidContentSizeChange(() => this.updateContentSize()));
		this._register(addDisposableListener(this.element, 'keydown', event => this.handleKeydown(event), true));
		this._register(addDisposableListener(this.element, 'keydown', event => {
			if (event.key === 'Escape' && !event.defaultPrevented && this.movedTextToCompare && !this.modelBinding?.accessibleDiffViewer.isVisible) {
				stopEvent(event);
				this.exitCompareMove();
			}
		}));
		this._register(this.modifiedEditor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.fontInfo)) {
				this.refresh();
			}
		}));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('diffEditor.renderIndicators')) {
				this.modelBinding?.diffDecorations.update(this.displayedDiff?.rows ?? LineDiffRows.empty, this.showInlineChanges, this.diffOptions.renderIndicators);
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
			// The first observation often confirms a viewport already supplied by its host.
			if (entry && (entry.contentRect.width !== this.viewportWidth || entry.contentRect.height !== this.viewportHeight)) {
				this.layout({ width: entry.contentRect.width, height: entry.contentRect.height });
			}
		}));
		this.codeEditorService.addDiffEditor(this);
		this._register(toDisposable(() => this.codeEditorService.removeDiffEditor(this)));
		// The first refresh lays out both sides and their alignment zones. Use
		// the final viewport for that pass instead of building a zero-width diff.
		const dimension = options.dimension ?? getClientArea(this.element);
		this.viewportWidth = dimension.width;
		this.viewportHeight = dimension.height;
		this.setModel(options.model);
	}

	/** Rebinds the editor pair without taking ownership of the comparison or its text models. */
	public setModel(model: DiffModel | null): void {
		this.assertNotDisposed();
		if ((this.modelBinding?.model ?? null) === model) return;
		if (this.changingModel) throw new Error('Cannot replace a diff model while it is changing');
		if (model?.isDisposed) throw new Error('Diff editor requires a live comparison');
		const hadFocus = this.hasFocus();
		if (hadFocus) this.element.focus({ preventScroll: true });
		this.changingModel = true;
		try {
			// Feature cleanup must run while its old editors and decoration owners
			// are still attached. No event may observe a half-rebound comparison.
			this.setAccessibleViewerVisible(false);
			this.modelBinding = undefined;
			this.modelResources.clear();
			this.activeChangeRow = -1;
			this.accessibilityStatusElement.textContent = '';
			this.incompleteStatusElement.hidden = true;
			this.incompleteStatusElement.textContent = '';
			// Model-change observers can inspect both sides. Detach the old pair
			// before attaching either new side, so two different files never pair up.
			this.originalEditor.setModel(null);
			this.modifiedEditor.setModel(null);
			if (model) {
				const detach = () => this.setModel(null);
				this.modelResources.add(model.original.onWillDispose(detach));
				this.modelResources.add(model.modified.onWillDispose(detach));
			}
			this.originalEditor.setModel(model?.original ?? null);
			this.modifiedEditor.setModel(model?.modified ?? null);
			if (model) this.createModelBinding(model);
		} catch (error) {
			this.modelBinding = undefined;
			this.modelResources.clear();
			this.originalEditor.setModel(null);
			this.modifiedEditor.setModel(null);
			throw error;
		} finally {
			this.changingModel = false;
		}
		this.refresh();
		this.updateContentSize();
		if (hadFocus && model) this.modifiedEditor.focus();
	}

	private createModelBinding(model: DiffModel): void {
		const resources = this.modelResources;
		const diffDecorations = resources.add(new DiffEditorDecorations(this.originalEditor, this.modifiedEditor));
		const viewModel = resources.add(new DiffEditorViewModel(model, this.originalEditor, this.modifiedEditor));
		const diffViewZones = resources.add(this.instantiationService.createInstance(DiffEditorViewZones, this.originalEditor, this.modifiedEditor, model));
		const overviewRuler = resources.add(new OverviewRulerFeature(this.element, this.originalEditor, this.modifiedEditor));
		const revertButtons = resources.add(new RevertButtonsFeature(this.modifiedEditor, model, this));
		const gutter = resources.add(this.instantiationService.createInstance(DiffEditorGutter, this.element, this.modifiedEditor, model, this,
			() => { this.updateFeatures(); this.layout({ width: this.viewportWidth, height: this.viewportHeight }); }));
		const movedBlocks = resources.add(new MovedBlocksLinesFeature(this.element, model, this.originalEditor, this.modifiedEditor, move => {
			if (move) {
				this.compareMove(move);
			} else {
				this.exitCompareMove();
			}
		}));
		const sash = resources.add(new DiffEditorSash(
			this.element,
			this.diffOptions,
			this.originalContainer.id,
			this.modifiedContainer.id,
			() => this.layout({ width: this.viewportWidth, height: this.viewportHeight }),
		));
		const hiddenRegions = resources.add(new HideUnchangedRegionsFeature(
			this.originalEditor,
			this.modifiedEditor,
			model,
			this.hideUnchangedRegionsOptions,
			this.instantiationService,
		));
		const accessibleDiffViewer = resources.add(new AccessibleDiffViewer(
			this.element,
			model,
			() => viewModel.diff.get(),
			direction => direction > 0 ? this.nextChange() : this.previousChange(),
			visible => this.setAccessibleViewerVisible(visible),
			() => this.modifiedEditor.focus(),
		));
		this.modelBinding = { model, diffDecorations, viewModel, diffViewZones, overviewRuler, revertButtons, gutter, movedBlocks, sash, hiddenRegions, accessibleDiffViewer };
		resources.add(gutter.onDidChangeContentHeight(() => this.updateContentSize()));
		resources.add(model.onDidChange(() => this.refresh()));
	}

	public getId(): string {
		return this.id;
	}

	public get diff(): LineDiff | undefined {
		return this.modelBinding?.model.diff;
	}

	public get wordWrap(): boolean {
		return this.diffOptions.wordWrap !== 'off';
	}

	private get displayedDiff(): LineDiff | undefined {
		return this.modelBinding?.viewModel.diff.get();
	}

	private get movedTextToCompare(): MovedText | undefined {
		return this.modelBinding?.viewModel.movedTextToCompare.get();
	}

	private compareMove(move: MovedText): void {
		const binding = this.modelBinding;
		if (!binding || this.changingModel || this.isDisposed) return;
		if (!binding.model.diff?.moves.includes(move) || this.inlineView || !this.diffOptions.showMoves) {
			return;
		}
		binding.accessibleDiffViewer.close();
		binding.viewModel.movedTextToCompare.set(move);
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
		const binding = this.modelBinding;
		if (!binding || this.changingModel || this.isDisposed) return;
		if (!this.movedTextToCompare) {
			return;
		}
		const line = binding.viewModel.getComparedRange()?.modified.startLineNumber;
		binding.accessibleDiffViewer.close();
		this.clearComparedMove();
		this.refresh();
		if (line) {
			this.modifiedEditor.revealRange(new Range(line, 1, line, 1), ScrollType.Immediate);
		}
		this.modifiedEditor.focus();
		this.modifiedEditor.announceAccessibilityStatus(localize('diffEditor.stoppedComparingMovedCode', 'Returned to the full comparison'));
	}

	private clearComparedMove(): void {
		this.modelBinding?.viewModel.movedTextToCompare.set(undefined);
	}

	public get currentChangeRow(): number {
		return this.activeChangeRow;
	}

	public get viewMode(): 'inline' | 'sideBySide' {
		return this.inlineView ? 'inline' : 'sideBySide';
	}

	protected get _targetEditor(): CodeEditorWidget {
		return this.modifiedEditor;
	}

	public getContentHeight(): number {
		const binding = this.modelBinding;
		return binding ? binding.movedBlocks.headerHeight + Math.max(this.editors.getContentHeight(), binding.gutter.getContentHeight()) : 0;
	}

	private updateContentSize(): void {
		if (this.changingModel || this.isDisposed) return;
		const binding = this.modelBinding;
		const contentHeight = this.getContentHeight();
		const contentWidth = binding ? (this.inlineView ? 0 : this.originalEditor.getContentWidth()) + this.modifiedEditor.getContentWidth() + binding.gutter.width + binding.movedBlocks.width : 0;
		const contentHeightChanged = contentHeight !== this.reportedContentHeight;
		const contentWidthChanged = contentWidth !== this.reportedContentWidth;
		if (!contentHeightChanged && !contentWidthChanged) return;
		this.reportedContentHeight = contentHeight;
		this.reportedContentWidth = contentWidth;
		this.contentSizeEmitter.fire({ contentHeight, contentWidth, contentHeightChanged, contentWidthChanged });
	}

	/** A control may outlive its result; only the current mapping can authorize an edit. */
	public revert(change: LineRangeMapping): void {
		const binding = this.modelBinding;
		if (!binding || this.changingModel || this.isDisposed) return;
		if (!binding.model.diff?.changes.some(current => current === change)
			|| this.movedTextToCompare || this.modifiedEditor.getOption(EditorOption.readOnly)) return;
		const target = change.modified;
		const lineCount = binding.model.modified.getLineCount();
		const endsAtDocumentEnd = target.endLineNumberExclusive > lineCount;
		const includesPrecedingBreak = endsAtDocumentEnd && target.startLineNumber > 1;
		const startLine = includesPrecedingBreak ? target.startLineNumber - 1 : target.startLineNumber;
		const endLine = endsAtDocumentEnd ? lineCount : target.endLineNumberExclusive;
		const range = new Range(startLine, includesPrecedingBreak ? binding.model.modified.getLineMaxColumn(startLine) : 1,
			endLine, endsAtDocumentEnd ? binding.model.modified.getLineMaxColumn(endLine) : 1);
		const lines = binding.model.original.getLinesContent().slice(change.original.startLineNumber - 1, change.original.endLineNumberExclusive - 1);
		const eol = binding.model.modified.getEOL();
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

	public revertRangeMappings(changes: readonly RangeMapping[]): void {
		const binding = this.modelBinding;
		if (!binding || this.changingModel || this.isDisposed) return;
		const diff = binding.model.diff;
		if (!diff || this.movedTextToCompare || this.modifiedEditor.getOption(EditorOption.readOnly)) return;
		const current = new Set(diff.changes.flatMap(change => change.innerChanges ?? []));
		if (changes.length === 0 || changes.some(change => !current.has(change))) return;
		const edits = changes.map(change => ({ range: change.modifiedRange, text: binding.model.original.getValueInRange(change.originalRange) }));
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
		return this.modelBinding?.accessibleDiffViewer.getAccessibleContent() ?? '';
	}

	public accessibleDiffViewerNext(): void {
		this.modelBinding?.accessibleDiffViewer.next();
	}

	public accessibleDiffViewerPrev(): void {
		this.modelBinding?.accessibleDiffViewer.previous();
	}

	public setAccessibilityHelpHint(enabled: boolean): void {
		this.accessibilityHelpHintEnabled = enabled;
		this.updateAccessibilityLabel();
	}

	public setConfiguredWordWrap(mode: NonNullable<IEditorOptions['wordWrap']>, column?: number): void {
		this.diffOptions.setConfiguredWordWrap(mode);
		if (column !== undefined) this.editors.updateOptions({ wordWrapColumn: column });
		this.updateWordWrap();
	}

	public setHideUnchangedRegionsOptions(options: HideUnchangedRegionsOptions): void {
		this.hideUnchangedRegionsOptions = options;
		this.modelBinding?.hiddenRegions.setOptions(options);
		this.updateFeatures();
		this.layout({ width: this.viewportWidth, height: this.viewportHeight });
	}

	public getOriginalEditor(): ICodeEditor {
		return this.originalEditor;
	}

	public getModifiedEditor(): ICodeEditor {
		return this.modifiedEditor;
	}

	public updateOptions(options: IDiffEditorOptions & Pick<DiffEditorWidgetOptions, 'showInlineChanges' | 'loopChanges' | 'originalAriaLabel' | 'modifiedAriaLabel'>): void {
		this.diffOptions.updateOptions(options);
		if (options.hideUnchangedRegions) {
			this.hideUnchangedRegionsOptions = { ...this.hideUnchangedRegionsOptions, ...options.hideUnchangedRegions };
			this.modelBinding?.hiddenRegions.setOptions(options.hideUnchangedRegions);
		}
		if ('originalAriaLabel' in options || 'modifiedAriaLabel' in options) {
			if ('originalAriaLabel' in options) this.originalLabel = options.originalAriaLabel ?? localize('diffEditor.original', 'Original');
			if ('modifiedAriaLabel' in options) this.modifiedLabel = options.modifiedAriaLabel ?? localize('diffEditor.modified', 'Modified');
			this.originalEditor.updateOptions({ ariaLabel: this.originalLabel });
			this.modifiedEditor.updateOptions({ ariaLabel: this.modifiedLabel });
			this.updateAccessibilityLabel();
		}
		this.showInlineChanges = options.showInlineChanges ?? this.showInlineChanges;
		this.loopChanges = options.loopChanges ?? this.loopChanges;
		this.configuredGlyphMargin = options.glyphMargin ?? this.configuredGlyphMargin;
		this.modifiedLineNumbersMinChars = options.lineNumbersMinChars ?? this.modifiedLineNumbersMinChars;
		this.element.classList.toggle('word-wrapped', this.wordWrap);
		this.editors.updateOptions({ ...options, wordWrap: this.diffOptions.wordWrap });
		this.modelBinding?.diffDecorations.update(this.displayedDiff?.rows ?? LineDiffRows.empty, this.showInlineChanges, this.diffOptions.renderIndicators);
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
		const binding = this.modelBinding;
		if (!binding || this.changingModel || this.isDisposed) return;
		const scrollTop = this.modifiedEditor.getScrollTop();
		const inlineView = this.diffOptions.isInlineView(size.width);
		if (inlineView !== this.inlineView) {
			this.inlineView = inlineView;
			this.element.classList.toggle('inline-view', inlineView);
			this.originalContainer.setAttribute('aria-hidden', String(inlineView || binding.accessibleDiffViewer.isVisible));
			if (inlineView && this.originalContainer.contains(this.element.ownerDocument.activeElement)) this.modifiedEditor.focus();
			this.originalContainer.inert = inlineView || binding.accessibleDiffViewer.isVisible;
			if (inlineView && this.movedTextToCompare) {
				this.clearComparedMove();
				binding.diffDecorations.update(binding.model.diff?.rows ?? LineDiffRows.empty, this.showInlineChanges, this.diffOptions.renderIndicators);
				binding.overviewRuler.setRows(binding.model.diff?.rows ?? LineDiffRows.empty);
			}
			this.updateFeatures();
		}
		const headerHeight = binding.movedBlocks.headerHeight;
		const editorHeight = Math.max(0, size.height - headerHeight);
		const centerWidth = binding.gutter.width + binding.movedBlocks.width;
		const splitWidth = Math.max(0, size.width - binding.overviewRuler.width);
		const contentWidth = Math.max(0, splitWidth - centerWidth);
		const sashHadFocus = binding.sash.element === this.element.ownerDocument.activeElement;
		// The action gutter occupies the original half, leaving the modified half at the split ratio.
		const originalSlot = binding.sash.layout(splitWidth, editorHeight, inlineView, headerHeight, centerWidth);
		const originalWidth = inlineView ? 0 : Math.max(0, originalSlot - centerWidth);
		if (binding.sash.element.hidden && sashHadFocus) this.modifiedEditor.focus();
		this.element.style.setProperty('--stanza-diff-original-width', `${originalWidth}px`);
		this.element.style.setProperty('--ash-diff-center-width', `${centerWidth}px`);
		this.element.style.setProperty('--ash-diff-overview-width', `${binding.overviewRuler.width}px`);
		this.element.style.setProperty('--ash-diff-header-height', `${headerHeight}px`);
		// One side can temporarily clamp its scroll before the paired alignment zones exist.
		// Commit both layouts before allowing either side to drive the comparison's position.
		const wasSyncingScroll = this.syncingScroll;
		this.syncingScroll = true;
		try {
			const originalDigits = Math.max(this.originalEditor.getOption(EditorOption.lineNumbersMinChars), String(binding.model.original.getLineCount()).length);
			this.originalEditor.updateOptions({ glyphMargin: inlineView ? false : this.configuredGlyphMargin });
			this.modifiedEditor.updateOptions({ lineNumbersMinChars: this.modifiedLineNumbersMinChars + (inlineView ? originalDigits + 1 : 0) });
			this.modifiedEditor.layout({ width: inlineView ? contentWidth : contentWidth - originalWidth, height: editorHeight });
			const modifiedLayout = this.modifiedEditor.getLayoutInfo();
			// The original editor supplies only its number column over the reserved
			// part of the modified margin. Both text layouts retain the same width.
			const originalEditorWidth = inlineView ? modifiedLayout.contentWidth + this.originalEditor.getLayoutInfo().contentLeft : originalWidth;
			this.originalEditor.layout({ width: Math.max(0, originalEditorWidth), height: editorHeight });
			const originalLayout = this.originalEditor.getLayoutInfo();
			this.element.style.setProperty('--ash-diff-original-line-numbers-width', `${inlineView ? originalLayout.lineNumbersWidth : 0}px`);
			this.element.style.setProperty('--ash-diff-original-line-numbers-left', `${modifiedLayout.lineNumbersLeft}px`);
			binding.diffViewZones.update(this.inlineView, this.wordWrap, this.displayedDiff?.rows ?? LineDiffRows.empty, this.diffOptions.renderIndicators, binding.viewModel.getComparedRange());
			this.modifiedEditor.setScrollTop(scrollTop, ScrollType.Immediate);
		} finally {
			this.syncingScroll = wasSyncingScroll;
		}
		this.synchronizeScroll(this.modifiedEditor, this.originalEditor);
		binding.gutter.layout(inlineView ? 0 : originalWidth);
		binding.movedBlocks.layout(originalWidth + binding.gutter.width, editorHeight);
		binding.overviewRuler.layout({ width: size.width, height: editorHeight });
		this.updateOverview();
		this.updateContentSize();
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

	/** Reveals the first change in the resolved comparison without taking keyboard focus. */
	public revealFirstDiff(): void {
		const model = this.modelBinding?.model;
		if (!model) return;
		const rows = model.diff?.rows;
		const first = model.diff?.hunks[0]?.rowStart ?? -1;
		if (!rows || first < 0) return;
		this.revealChangeRow(first);
		const row = rows.get(first)!;
		const line = Math.min(model.modified.lineCount, (row.modifiedLineIndex ?? row.originalLineIndex ?? 0) + 1);
		this.setPosition({ lineNumber: line, column: 1 });
		if (row.modifiedLineIndex !== undefined) {
			this.modifiedEditor.revealRangeInCenter(new Range(line, 1, line, 1), ScrollType.Immediate);
		}
	}

	/** Restores the navigation cursor without replacing the editor selection or scroll. */
	public restoreChangeRow(rowIndex: number): void {
		const row = this.modelBinding?.model.diff?.rows.get(rowIndex);
		this.activeChangeRow = row && row.kind !== LineDiffKind.Unchanged ? rowIndex : -1;
	}

	/** Selects one changed row in this comparison; the caller may announce collection-wide navigation. */
	public revealChangeRow(rowIndex: number, announce = true): void {
		const rows = this.modelBinding?.model.diff?.rows;
		if (!rows || !isNonNegativeSafeInteger(rowIndex) || rows.get(rowIndex)?.kind === LineDiffKind.Unchanged || !rows.get(rowIndex)) {
			throw new RangeError('Diff change row is outside the current result');
		}
		if (this.movedTextToCompare) {
			this.exitCompareMove();
		}
		this.revealDiffRow(rows, rowIndex, announce);
	}

	private revealDiffRow(rows: LineDiffRows, rowIndex: number, announce: boolean): void {
		this.activeChangeRow = rowIndex;
		const row = rows.get(rowIndex)!;
		let signal = AccessibilitySignal.diffLineModified;
		if (row.kind === LineDiffKind.Added) { signal = AccessibilitySignal.diffLineInserted; }
		if (row.kind === LineDiffKind.Removed) { signal = AccessibilitySignal.diffLineDeleted; }
		void this.signals.playSignal(signal);
		if (row.modifiedLineIndex !== undefined) {
			const lineNumber = row.modifiedLineIndex + 1;
			const column = (row.modifiedChanges[0]?.startColumn ?? 0) + 1;
			// A point on a wrap boundary can resolve to the preceding visual line.
			const endColumn = (row.modifiedChanges[0]?.endColumn ?? column - 1) + 1;
			this.modifiedEditor.revealRangeInCenter(new Range(lineNumber, column, lineNumber, endColumn), ScrollType.Immediate);
		} else if (row.originalLineIndex !== undefined && !this.inlineView) {
			const lineNumber = row.originalLineIndex + 1;
			const column = (row.originalChanges[0]?.startColumn ?? 0) + 1;
			const endColumn = (row.originalChanges[0]?.endColumn ?? column - 1) + 1;
			this.originalEditor.revealRangeInCenter(new Range(lineNumber, column, lineNumber, endColumn), ScrollType.Immediate);
		} else if (this.inlineView) {
			// A removed line lives in a zone after its preceding modified line, not at its original line number.
			let precedingRow = rowIndex - 1;
			while (precedingRow >= 0 && rows.get(precedingRow)!.modifiedLineIndex === undefined) {
				precedingRow--;
			}
			const precedingLine = rows.get(precedingRow)?.modifiedLineIndex;
			const top = precedingLine === undefined
				? this.modifiedEditor.getOption(EditorOption.padding).top
				: this.modifiedEditor.getBottomForLineNumber(precedingLine + 1);
			const zoneTop = top + (rowIndex - precedingRow - 1) * this.modifiedEditor.getOption(EditorOption.lineHeight);
			this.modifiedEditor.setScrollTop(Math.max(0, zoneTop - this.modifiedEditor.getLayoutInfo().height / 2), ScrollType.Immediate);
		}
		if (announce) {
			const changedRows = Array.from(rows.changedEntries(), ([index]) => index);
			this.accessibilityStatusElement.textContent = localize(
				'diffEditor.changeLocation', 'Change {0} of {1}, {2}',
				changedRows.indexOf(rowIndex) + 1, changedRows.length, this.diffRowLocation(row),
			);
		}
	}

	public clearActiveChange(): void {
		this.activeChangeRow = -1;
	}

	private updateWordWrap(): void {
		this.element.classList.toggle('word-wrapped', this.wordWrap);
		const wordWrap = this.diffOptions.wordWrap;
		this.originalEditor.updateOptions({ wordWrap });
		this.modifiedEditor.updateOptions({ wordWrap });
		this.layout({ width: this.viewportWidth, height: this.viewportHeight });
	}

	private refresh(): void {
		const binding = this.modelBinding;
		if (!binding || this.changingModel || this.isDisposed) return;
		// Pending comparisons can remove alignment zones before the next result
		// adds them back. Preserve a model row, including the last row at EOF,
		// rather than a pixel offset that can be clamped by that temporary layout.
		const scrollState = this.modifiedEditor.getScrollTop() + this.modifiedEditor.getLayoutInfo().height >= this.modifiedEditor.getContentHeight()
			? StableEditorBottomScrollState.capture(this.modifiedEditor)
			: StableEditorScrollState.capture(this.modifiedEditor);
		this.activeChangeRow = -1;
		this.accessibilityStatusElement.textContent = binding.model.state.kind === 'loading'
			? localize('diffEditor.computing', 'Computing differences')
			: binding.model.state.kind === 'error'
				? localize('diffEditor.error', 'Could not compute differences: {0}', binding.model.state.error.message)
				: '';
		this.updateIncompleteStatus();
		this.updateFeatures();
		binding.diffDecorations.update(this.displayedDiff?.rows ?? LineDiffRows.empty, this.showInlineChanges, this.diffOptions.renderIndicators);
		binding.overviewRuler.setRows(this.displayedDiff?.rows ?? LineDiffRows.empty);
		this.layout({ width: this.viewportWidth, height: this.viewportHeight });
		scrollState.restore(this.modifiedEditor);
	}

	private updateFeatures(): void {
		const binding = this.modelBinding;
		if (!binding || this.changingModel || this.isDisposed) return;
		if (!this.diffOptions.showMoves && this.movedTextToCompare) {
			this.clearComparedMove();
			binding.diffDecorations.update(binding.model.diff?.rows ?? LineDiffRows.empty, this.showInlineChanges, this.diffOptions.renderIndicators);
			binding.overviewRuler.setRows(binding.model.diff?.rows ?? LineDiffRows.empty);
		}
		binding.gutter.update(this.diffOptions.renderGutterMenu && !this.movedTextToCompare, this.inlineView);
		// Legacy margin arrows only apply to side-by-side comparisons with the
		// gutter menu disabled; menu actions are independent of the margin setting.
		const marginEnabled = this.diffOptions.renderMarginRevertIcon && !this.diffOptions.renderGutterMenu && !this.inlineView && !this.movedTextToCompare;
		binding.revertButtons.update(marginEnabled);
		this.modifiedEditor.updateOptions({ glyphMargin: this.configuredGlyphMargin || binding.hiddenRegions.isEnabled || (marginEnabled && !this.modifiedEditor.getOption(EditorOption.readOnly)) });
		binding.movedBlocks.update(this.diffOptions.showMoves && !this.inlineView, this.movedTextToCompare);
		binding.overviewRuler.setEnabled(this.diffOptions.renderOverviewRuler);
	}

	private updateIncompleteStatus(): void {
		const binding = this.modelBinding;
		if (!binding) return;
		this.incompleteStatusElement.hidden = binding.model.state.kind !== 'ready' || !binding.model.state.quitEarly;
		this.incompleteStatusElement.textContent = this.incompleteStatusElement.hidden
			? ''
			: localize('diffEditor.incomplete', 'Diff computation stopped after the time limit. Results may be incomplete.');
	}

	private setAccessibleViewerVisible(visible: boolean): void {
		this.element.classList.toggle('accessible-view-open', visible);
		this.originalContainer.setAttribute('aria-hidden', String(visible || this.inlineView));
		this.modifiedContainer.setAttribute('aria-hidden', String(visible));
		const sash = this.modelBinding?.sash.element;
		sash?.setAttribute('aria-hidden', String(visible));
		this.originalContainer.inert = visible || this.inlineView;
		this.modifiedContainer.inert = visible;
		if (sash) sash.inert = visible;
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
		const binding = this.modelBinding;
		if (!binding) throw new Error('Diff results are not ready');
		const diff = binding.model.diff;
		if (!diff) throw new Error('Diff results are not ready');
		const source = side === 'originalLineIndex' ? binding.model.original : binding.model.modified;
		if (lineIndex >= source.lineCount) throw new RangeError('Diff line index is outside its source model');
		const editor = side === 'originalLineIndex' ? this.originalEditor : this.modifiedEditor;
		editor.revealRange(new Range(lineIndex + 1, 1, lineIndex + 1, 1), ScrollType.Immediate);
	}

	private selectRelativeChange(delta: -1 | 1): number | undefined {
		const diff = this.displayedDiff;
		if (!diff) {
			this.accessibilityStatusElement.textContent = localize('diffEditor.computing', 'Computing differences');
			return undefined;
		}
		const changedRows = Array.from(diff.rows.changedEntries(), ([index]) => index);
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
		if (this.syncingScroll || this.changingModel || !this.modelBinding) return;
		// The inline original is a passive number column. Model updates can clamp
		// its scroll before alignment is rebuilt; the modified editor owns that position.
		if (this.inlineView && source === this.originalEditor) return;
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
		this.modelBinding?.overviewRuler.updateViewport(this.modifiedEditor.getContentHeight(), this.modifiedEditor.getScrollTop());
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
