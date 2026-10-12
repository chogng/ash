import { addDisposableListener, getWindow, h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, observableValue, type IReader } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { type IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { EditorOption } from '../../../../common/config/editorOptions.js';
import { type HideUnchangedRegionsOptions } from '../../../../common/config/diffEditor.js';
import { LineRange } from '../../../../common/core/ranges/lineRange.js';
import { Range } from '../../../../common/core/range.js';
import { type DiffModel } from '../../../../common/diff/diffModel.js';
import { LineDiffKind, type LineDiff } from '../../../../common/diff/lineDiff.js';
import { type LanguageSymbolKind } from '../../../../common/languages.js';
import { type TextModel } from '../../../../common/model/textModel.js';
import { GlyphMarginLane } from '../../../../common/model.js';
import { type IGlyphMarginWidget, type IOverlayWidget, type IViewZoneChangeAccessor } from '../../../editorBrowser.js';
import { type CodeEditorWidget } from '../../codeEditor/codeEditorWidget.js';

export interface IDiffEditorBreadcrumbsSource extends IDisposable {
	getBreadcrumbItems(startRange: LineRange, reader: IReader): { name: string; kind: LanguageSymbolKind; startLineNumber: number; }[];
	getAt(lineNumber: number, reader: IReader): { name: string; kind: LanguageSymbolKind; startLineNumber: number; }[];
}

const HIDDEN_REGION_HEIGHT = 40;

interface RegionZone extends IDisposable {
	update(range: LineRange): void;
}

interface UnchangedRegion {
	readonly original: LineRange;
	readonly modified: LineRange;
	revealedAbove: number;
	revealedBelow: number;
}

/** Owns paired hidden ranges and the controls that reveal them. */
export class HideUnchangedRegionsFeature extends Disposable {
	private static breadcrumbsSourceFactory: ((model: TextModel, instantiationService: IInstantiationService) => IDiffEditorBreadcrumbsSource) | undefined;

	public static setBreadcrumbsSourceFactory(factory: (model: TextModel, instantiationService: IInstantiationService) => IDiffEditorBreadcrumbsSource): void {
		this.breadcrumbsSourceFactory = factory;
	}

	private readonly zones = this._register(new DisposableStore());
	private readonly regionZones = this._register(new DisposableMap<UnchangedRegion, IDisposable & { update(original: LineRange, modified: LineRange): void }>());
	private readonly drag = this._register(new MutableDisposable<DisposableStore>());
	private draggedRegion: UnchangedRegion | undefined;
	private readonly source = this._register(new MutableDisposable<IDiffEditorBreadcrumbsSource>());
	private regions: UnchangedRegion[] = [];
	private options: HideUnchangedRegionsOptions;
	private isUpdatingHiddenAreas = false;

	constructor(
		private readonly original: CodeEditorWidget,
		private readonly modified: CodeEditorWidget,
		private readonly model: DiffModel,
		options: HideUnchangedRegionsOptions,
		private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.options = validateOptions(options);
		if (options.enabled) this.connectSource();
		this._register(model.onDidChange(() => this.recompute()));
		for (const [editor, side] of [[original, 'original'], [modified, 'modified']] as const) {
			this._register(editor.onDidChangeCursorSelection(() => {
				if (this.isUpdatingHiddenAreas) {
					return;
				}
				let changed = false;
				for (const region of this.regions) {
					const range = hiddenRange(region[side], region);
					if (!range) continue;
					const selected = editor.getSelections()?.some(selection =>
						selection.startLineNumber < range.endLineNumberExclusive && selection.endLineNumber >= range.startLineNumber);
					if (selected) {
						region.revealedAbove = region.original.length;
						changed = true;
					}
				}
				if (changed) this.render();
			}));
		}
		this._register(toDisposable(() => {
			this.zones.clear();
			this.original.setHiddenAreas([]);
			this.modified.setHiddenAreas([]);
		}));
		this.recompute();
	}

	public get isEnabled(): boolean {
		return this.options.enabled;
	}

	public setOptions(options: HideUnchangedRegionsOptions): void {
		validateOptions(options);
		if (sameOptions(this.options, options)) return;
		this.options = options;
		if (options.enabled && !this.source.value) this.connectSource();
		if (!options.enabled) this.source.clear();
		this.recompute();
	}

	private connectSource(): void {
		const factory = HideUnchangedRegionsFeature.breadcrumbsSourceFactory;
		if (!factory) throw new Error('Diff editor breadcrumbs contribution is not registered');
		this.source.value = factory(this.model.modified, this.instantiationService);
	}

	private recompute(): void {
		this.drag.clear();
		this.regionZones.clearAndDisposeAll();
		this.regions = this.options.enabled && this.model.diff
			? unchangedRegions(this.model.diff, this.options)
			: [];
		this.render();
	}

	private render(): void {
		this.zones.clear();
		// Retain the captured handle at zero hidden lines so the same drag can reverse.
		const visibleRegions = this.regions.flatMap(region => {
			const original = hiddenRange(region.original, region, this.draggedRegion === region);
			const modified = hiddenRange(region.modified, region, this.draggedRegion === region);
			return original && modified ? [{ region, original, modified }] : [];
		});
		this.isUpdatingHiddenAreas = true;
		try {
			this.original.setHiddenAreas(visibleRegions.flatMap(({ original }) => original.toInclusiveRange() ?? []));
			this.modified.setHiddenAreas(visibleRegions.flatMap(({ modified }) => modified.toInclusiveRange() ?? []));
		} finally {
			this.isUpdatingHiddenAreas = false;
		}
		const visible = new Set(visibleRegions.map(({ region }) => region));
		for (const region of this.regionZones.keys()) {
			if (!visible.has(region)) { this.regionZones.deleteAndDispose(region); }
		}
		for (const { region, original, modified } of visibleRegions) {
			let zones = this.regionZones.get(region);
			if (!zones) {
				const resources = new DisposableStore();
				const left = resources.add(this.addZone(this.original, original, region, false));
				const right = resources.add(this.addZone(this.modified, modified, region, true));
				zones = this.regionZones.set(region, Object.assign(resources, {
					update: (original: LineRange, modified: LineRange): void => { left.update(original); right.update(modified); },
				}));
			}
			zones.update(original, modified);
		}
		for (const region of this.regions) {
			if (hiddenRange(region.original, region) || this.draggedRegion === region) {
				continue;
			}
			this.addCollapseButton(this.original, region, region.original);
			this.addCollapseButton(this.modified, region, region.modified);
		}
	}

	private addCollapseButton(editor: CodeEditorWidget, region: UnchangedRegion, range: LineRange): void {
		const domNode = h(editor.getDomNode().ownerDocument, 'div');
		domNode.className = 'ash-diff-fold-unchanged';
		const label = localize('diffEditor.foldUnchanged', 'Collapse unchanged region');
		const button = this.zones.add(new Button(domNode, { label, title: label, icon: Lxicon.fold, iconOnly: true, size: 'small' }));
		this.zones.add(button.onDidClick(() => {
			region.revealedAbove = 0;
			region.revealedBelow = 0;
			// Restoring a removed region also restores document order for keyboard navigation.
			this.regionZones.clearAndDisposeAll();
			this.render();
			const line = range.startLineNumber > 1 ? range.startLineNumber - 1 : range.endLineNumberExclusive;
			editor.revealRange(new Range(line, 1, line, 1));
			editor.focus();
			editor.announceAccessibilityStatus(localize('diffEditor.collapsedLines', 'Collapsed {0} unchanged lines', range.length));
		}));
		const widget: IGlyphMarginWidget = {
			getId: () => `diff-fold-unchanged-${range.startLineNumber}`,
			getDomNode: () => domNode,
			getPosition: () => ({ range: new Range(range.startLineNumber, 1, range.startLineNumber, 1), lane: GlyphMarginLane.Center, zIndex: 20 }),
		};
		editor.addGlyphMarginWidget(widget);
		this.zones.add(toDisposable(() => editor.removeGlyphMarginWidget(widget)));
	}

	private addZone(editor: CodeEditorWidget, initialRange: LineRange, region: UnchangedRegion, showBreadcrumbs: boolean): RegionZone {
		const resources = new DisposableStore();
		let range = initialRange;
		const domNode = h(editor.getDomNode().ownerDocument, 'div');
		domNode.className = 'ash-diff-hidden-region';
		const content = h(domNode.ownerDocument, 'div');
		content.className = 'ash-diff-hidden-region-content';
		domNode.append(content);
		const disclosure = h(domNode.ownerDocument, 'div');
		disclosure.className = 'ash-diff-hidden-region-disclosure';
		content.append(disclosure);
		const count = h(domNode.ownerDocument, 'span');
		count.className = 'ash-diff-hidden-region-count';
		count.textContent = localize('diffEditor.hiddenLines', '{0} hidden lines', range.length);
		count.title = count.textContent;
		content.append(count);
		resources.add(addDisposableListener(count, 'dblclick', event => {
			if (event.button !== 0) {
				return;
			}
			event.preventDefault();
			region.revealedAbove = region.original.length;
			this.render();
			editor.revealRange(new Range(range.startLineNumber, 1, range.startLineNumber, 1));
			editor.focus();
			editor.announceAccessibilityStatus(localize('diffEditor.revealedLines', 'Revealed {0} unchanged lines', range.length));
		}));

		const above = this.addButton(resources, domNode, localize('diffEditor.showMoreAbove', 'Show {0} more lines above', Math.min(range.length, this.options.revealLineCount)), 'ash-diff-hidden-region-above', () => {
			const count = Math.min(range.length, this.options.revealLineCount);
			const line = range.startLineNumber;
			region.revealedAbove += count;
			this.render();
			editor.revealRange(new Range(line, 1, line, 1));
			editor.focus();
			editor.announceAccessibilityStatus(localize('diffEditor.revealedLines', 'Revealed {0} unchanged lines', count));
		});
		const showAllLabel = localize('diffEditor.showAll', 'Show all unchanged lines');
		const showAll = resources.add(new Button(disclosure, {
			label: showAllLabel,
			title: showAllLabel,
			icon: Lxicon.unfold,
			iconOnly: true,
			presentation: 'quiet',
			size: 'small',
		}));
		resources.add(showAll.onDidClick(() => {
			region.revealedAbove = region.original.length;
			this.render();
			editor.revealRange(new Range(range.startLineNumber, 1, range.startLineNumber, 1));
			editor.focus();
			editor.announceAccessibilityStatus(localize('diffEditor.revealedLines', 'Revealed {0} unchanged lines', range.length));
		}));
		const below = this.addButton(resources, domNode, localize('diffEditor.showMoreBelow', 'Show {0} more lines below', Math.min(range.length, this.options.revealLineCount)), 'ash-diff-hidden-region-below', () => {
			const count = Math.min(range.length, this.options.revealLineCount);
			const line = range.endLineNumberExclusive - 1;
			region.revealedBelow += count;
			this.render();
			editor.revealRange(new Range(line, 1, line, 1));
			editor.focus();
			editor.announceAccessibilityStatus(localize('diffEditor.revealedLines', 'Revealed {0} unchanged lines', count));
		});

		const currentRange = observableValue('hidden region range', range);
		const source = this.source.value;
		if (showBreadcrumbs && source) {
			const breadcrumbs = h(domNode.ownerDocument, 'span');
			breadcrumbs.className = 'ash-diff-hidden-region-breadcrumbs';
			content.append(breadcrumbs);
			resources.add(autorun(reader => {
				breadcrumbs.replaceChildren(...source.getBreadcrumbItems(currentRange.read(reader), reader).map(item => {
					const button = h(breadcrumbs.ownerDocument, 'button');
					button.type = 'button';
					button.className = 'ash-diff-hidden-region-symbol';
					button.textContent = item.name;
					button.title = localize('diffEditor.revealSymbol', 'Go to {0}', item.name);
					button.dataset.line = String(item.startLineNumber);
					return button;
				}));
				breadcrumbs.hidden = breadcrumbs.childElementCount === 0;
			}));
			resources.add(addDisposableListener(breadcrumbs, 'click', event => {
				const target = event.target;
				if (!(target instanceof HTMLElement) || target.tagName !== 'BUTTON' || !target.dataset.line) return;
				region.revealedAbove = region.original.length;
				this.render();
				const line = Number(target.dataset.line);
				this.modified.revealRange(new Range(line, 1, line, 1));
				this.modified.focus();
			}));
		}

		let id!: string;
		let top: number | undefined;
		const overlay: IOverlayWidget = {
			getId: () => `ash-diff-hidden-region-${editor.getId()}-${id}`,
			getDomNode: () => domNode,
			getPosition: () => top === undefined ? null : { preference: { top, left: 0 } },
		};
		const layout = (): void => {
			const info = editor.getLayoutInfo();
			domNode.style.width = `${info.width - info.verticalScrollbarWidth}px`;
			disclosure.style.width = `${info.contentLeft}px`;
			editor.layoutOverlayWidget(overlay);
		};
		this.addDrag(resources, above, editor, region, 'revealedAbove');
		this.addDrag(resources, below, editor, region, 'revealedBelow');
		const zone = {
			afterLineNumber: range.startLineNumber - 1,
			heightInPx: HIDDEN_REGION_HEIGHT,
			showInHiddenAreas: true,
			domNode: h(domNode.ownerDocument, 'div'),
			onDomNodeTop: (position: number): void => {
				const nextTop = position + HIDDEN_REGION_HEIGHT <= 0 ? undefined : position;
				if (top === nextTop) { return; }
				top = nextTop;
				editor.layoutOverlayWidget(overlay);
			},
		};
		// The zone owns vertical space; the overlay keeps disclosure controls fixed to the viewport during horizontal scrolling.
		editor.changeViewZones(accessor => { id = accessor.addZone(zone); });
		editor.addOverlayWidget(overlay);
		layout();
		resources.add(editor.onDidLayoutChange(layout));
		resources.add(toDisposable(() => editor.removeOverlayWidget(overlay)));
		resources.add(toDisposable(() => editor.changeViewZones((accessor: IViewZoneChangeAccessor) => accessor.removeZone(id))));
		return Object.assign(resources, {
			update: (nextRange: LineRange): void => {
				if (range.equals(nextRange)) { return; }
				range = nextRange;
				currentRange.set(range, undefined);
				count.textContent = localize('diffEditor.hiddenLines', '{0} hidden lines', range.length);
				count.title = count.textContent;
				above.label = localize('diffEditor.showMoreAbove', 'Show {0} more lines above', Math.min(range.length, this.options.revealLineCount));
				below.label = localize('diffEditor.showMoreBelow', 'Show {0} more lines below', Math.min(range.length, this.options.revealLineCount));
				above.setTitle(above.label);
				below.setTitle(below.label);
				zone.afterLineNumber = range.startLineNumber - 1;
				editor.changeViewZones(accessor => accessor.layoutZone(id));
			},
		});
	}

	private addButton(resources: DisposableStore, container: HTMLElement, label: string, className: string, action: () => void): Button {
		const button = resources.add(new Button(container, { label, title: label, iconOnly: true, presentation: 'quiet', size: 'small' }));
		button.domNode.classList.add(className);
		resources.add(button.onDidClick(event => {
			// Pointer activation is committed on pointerup so a drag never also clicks.
			if (event.detail === 0) { action(); }
		}));
		return button;
	}

	private addDrag(resources: DisposableStore, button: Button, editor: CodeEditorWidget, region: UnchangedRegion, side: 'revealedAbove' | 'revealedBelow'): void {
		button.domNode.setAttribute('aria-description', localize('diffEditor.dragHiddenRegion', 'Drag to reveal or hide unchanged lines. Press Enter or Space to reveal more lines.'));
		resources.add(addDisposableListener(button.domNode, 'pointerdown', event => {
			if (event.button !== 0) { return; }
			event.preventDefault();
			event.stopPropagation();
			this.drag.clear();
			const drag = new DisposableStore();
			this.drag.value = drag;
			this.draggedRegion = region;
			button.domNode.classList.add('dragging');
			button.domNode.setPointerCapture(event.pointerId);
			const start = region[side];
			const lineHeight = editor.getOptions().get(EditorOption.lineHeight);
			let didMove = false;
			drag.add(toDisposable(() => {
				this.draggedRegion = undefined;
				button.domNode.classList.remove('dragging');
				if (button.domNode.hasPointerCapture(event.pointerId)) {
					button.domNode.releasePointerCapture(event.pointerId);
				}
			}));
			const targetWindow = getWindow(button.domNode);
			drag.add(addDisposableListener(targetWindow, 'pointermove', next => {
				if (next.pointerId !== event.pointerId) { return; }
				const delta = next.clientY - event.clientY;
				didMove ||= Math.abs(delta) > 2;
				const other = side === 'revealedAbove' ? region.revealedBelow : region.revealedAbove;
				const direction = side === 'revealedAbove' ? 1 : -1;
				const value = Math.max(0, Math.min(region.original.length - other, start + Math.round(direction * delta / lineHeight)));
				if (region[side] === value) { return; }
				// Keep the lower context at its editor viewport position when revealing from the bottom.
				const anchor = region[editor === this.original ? 'original' : 'modified'].endLineNumberExclusive;
				const offset = editor.getTopForLineNumber(anchor) - editor.getScrollTop();
				region[side] = value;
				this.render();
				if (side === 'revealedBelow') { editor.setScrollTop(editor.getTopForLineNumber(anchor) - offset); }
			}));
			const finish = (activate: boolean): void => {
				const delta = region[side] - start;
				this.drag.clear();
				if (!didMove && activate) {
					button.domNode.click();
					return;
				}
				this.render();
				if (delta > 0) { editor.announceAccessibilityStatus(localize('diffEditor.revealedLines', 'Revealed {0} unchanged lines', delta)); }
				if (delta < 0) { editor.announceAccessibilityStatus(localize('diffEditor.collapsedLines', 'Collapsed {0} unchanged lines', -delta)); }
				editor.focus();
			};
			drag.add(addDisposableListener(targetWindow, 'pointerup', next => {
				if (next.pointerId === event.pointerId) { finish(true); }
			}));
			drag.add(addDisposableListener(targetWindow, 'pointercancel', next => {
				if (next.pointerId === event.pointerId) { finish(false); }
			}));
			drag.add(addDisposableListener(targetWindow, 'blur', () => finish(false)));
		}));
	}
}

function hiddenRange(range: LineRange, region: UnchangedRegion, includeEmpty = false): LineRange | undefined {
	const start = range.startLineNumber + region.revealedAbove;
	const end = range.endLineNumberExclusive - region.revealedBelow;
	return start < end || includeEmpty ? new LineRange(start, end) : undefined;
}

function unchangedRegions(diff: LineDiff, options: HideUnchangedRegionsOptions): UnchangedRegion[] {
	if (diff.hunks.length === 0) return [];
	const regions: UnchangedRegion[] = [];
	for (let start = 0; start < diff.rows.length;) {
		if (diff.rows[start].kind !== LineDiffKind.Unchanged) { start++; continue; }
		let end = start + 1;
		while (end < diff.rows.length && diff.rows[end].kind === LineDiffKind.Unchanged) end++;
		const contextAbove = start === 0 ? 0 : options.contextLineCount;
		const contextBelow = end === diff.rows.length ? 0 : options.contextLineCount;
		if (end - start - contextAbove - contextBelow >= options.minimumLineCount) {
			const first = diff.rows[start + contextAbove];
			const last = diff.rows[end - contextBelow - 1];
			regions.push({
				original: new LineRange(first.originalLineIndex! + 1, last.originalLineIndex! + 2),
				modified: new LineRange(first.modifiedLineIndex! + 1, last.modifiedLineIndex! + 2),
				revealedAbove: 0,
				revealedBelow: 0,
			});
		}
		start = end;
	}
	return regions;
}

function sameOptions(left: HideUnchangedRegionsOptions, right: HideUnchangedRegionsOptions): boolean {
	return left.enabled === right.enabled && left.contextLineCount === right.contextLineCount
		&& left.minimumLineCount === right.minimumLineCount && left.revealLineCount === right.revealLineCount;
}

function validateOptions(options: HideUnchangedRegionsOptions): HideUnchangedRegionsOptions {
	if (typeof options.enabled !== 'boolean') throw new TypeError('hideUnchangedRegions.enabled must be boolean');
	for (const [name, value] of [
		['contextLineCount', options.contextLineCount],
		['minimumLineCount', options.minimumLineCount],
		['revealLineCount', options.revealLineCount],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`hideUnchangedRegions.${name} must be a positive integer`);
	}
	return options;
}
