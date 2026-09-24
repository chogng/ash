import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, type IReader } from '../../../../../base/common/observable.js';
import { localize, onDidChangeNls } from '../../../../../nls.js';
import { type IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { type HideUnchangedRegionsOptions } from '../../../../common/config/diffEditor.js';
import { LineRange } from '../../../../common/core/ranges/lineRange.js';
import { Range } from '../../../../common/core/range.js';
import { type DiffModel } from '../../../../common/diff/diffModel.js';
import { LineDiffKind, type LineDiff } from '../../../../common/diff/lineDiff.js';
import { type LanguageSymbolKind } from '../../../../common/languages.js';
import { type TextModel } from '../../../../common/model/textModel.js';
import { type IViewZoneChangeAccessor } from '../../../editorBrowser.js';
import { type CodeEditorWidget } from '../../codeEditor/codeEditorWidget.js';

export interface IDiffEditorBreadcrumbsSource extends IDisposable {
	getBreadcrumbItems(startRange: LineRange, reader: IReader): { name: string; kind: LanguageSymbolKind; startLineNumber: number }[];
	getAt(lineNumber: number, reader: IReader): { name: string; kind: LanguageSymbolKind; startLineNumber: number }[];
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
	private readonly source = this._register(new MutableDisposable<IDiffEditorBreadcrumbsSource>());
	private regions: UnchangedRegion[] = [];
	private options: HideUnchangedRegionsOptions;

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
		this._register(onDidChangeNls(() => this.render()));
		this._register(toDisposable(() => {
			this.zones.clear();
			this.original.setHiddenAreas([]);
			this.modified.setHiddenAreas([]);
		}));
		this.recompute();
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
		this.regions = this.options.enabled && this.model.diff
			? unchangedRegions(this.model.diff, this.options)
			: [];
		this.render();
	}

	private render(): void {
		this.zones.clear();
		const visibleRegions = this.regions.flatMap(region => {
			const original = hiddenRange(region.original, region);
			const modified = hiddenRange(region.modified, region);
			return original && modified ? [{ region, original, modified }] : [];
		});
		this.original.setHiddenAreas(visibleRegions.map(({ original }) => original.toInclusiveRange()!));
		this.modified.setHiddenAreas(visibleRegions.map(({ modified }) => modified.toInclusiveRange()!));
		for (const { region, original, modified } of visibleRegions) {
			this.addZone(this.original, original, region, false);
			this.addZone(this.modified, modified, region, true);
		}
	}

	private addZone(editor: CodeEditorWidget, range: LineRange, region: UnchangedRegion, showBreadcrumbs: boolean): void {
		const domNode = h(editor.getDomNode().ownerDocument, 'div');
		domNode.className = 'ash-diff-hidden-region';
		const content = h(domNode.ownerDocument, 'div');
		content.className = 'ash-diff-hidden-region-content';
		domNode.append(content);
		const count = h(domNode.ownerDocument, 'span');
		count.className = 'ash-diff-hidden-region-count';
		count.textContent = localize('diffEditor.hiddenLines', '{0} hidden lines', range.length);
		count.title = count.textContent;
		content.append(count);

		this.addButton(content, localize('diffEditor.showMoreAbove', 'Show {0} more lines above', Math.min(range.length, this.options.revealLineCount)), '↑', () => {
			const count = Math.min(range.length, this.options.revealLineCount);
			region.revealedAbove += count;
			this.render();
			editor.revealRange(new Range(range.startLineNumber, 1, range.startLineNumber, 1));
			editor.focus();
			editor.announceAccessibilityStatus(localize('diffEditor.revealedLines', 'Revealed {0} unchanged lines', count));
		});
		this.addButton(content, localize('diffEditor.showAll', 'Show all unchanged lines'), '⋯', () => {
			region.revealedAbove = region.original.length;
			this.render();
			editor.revealRange(new Range(range.startLineNumber, 1, range.startLineNumber, 1));
			editor.focus();
			editor.announceAccessibilityStatus(localize('diffEditor.revealedLines', 'Revealed {0} unchanged lines', range.length));
		});
		this.addButton(content, localize('diffEditor.showMoreBelow', 'Show {0} more lines below', Math.min(range.length, this.options.revealLineCount)), '↓', () => {
			const count = Math.min(range.length, this.options.revealLineCount);
			region.revealedBelow += count;
			this.render();
			const line = range.endLineNumberExclusive - 1;
			editor.revealRange(new Range(line, 1, line, 1));
			editor.focus();
			editor.announceAccessibilityStatus(localize('diffEditor.revealedLines', 'Revealed {0} unchanged lines', count));
		});

		const source = this.source.value;
		if (showBreadcrumbs && source) {
			const breadcrumbs = h(domNode.ownerDocument, 'span');
			breadcrumbs.className = 'ash-diff-hidden-region-breadcrumbs';
			content.append(breadcrumbs);
			this.zones.add(autorun(reader => {
				breadcrumbs.replaceChildren(...source.getBreadcrumbItems(range, reader).map(item => {
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
			this.zones.add(addDisposableListener(breadcrumbs, 'click', event => {
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
		editor.changeViewZones(accessor => { id = accessor.addZone({ afterLineNumber: range.startLineNumber - 1, heightInPx: 32, showInHiddenAreas: true, isAccessible: true, domNode }); });
		this.zones.add(toDisposable(() => editor.changeViewZones((accessor: IViewZoneChangeAccessor) => accessor.removeZone(id))));
	}

	private addButton(container: HTMLElement, label: string, icon: string, action: () => void): void {
		const button = h(container.ownerDocument, 'button');
		button.type = 'button';
		button.textContent = icon;
		button.setAttribute('aria-label', label);
		button.title = label;
		container.append(button);
		this.zones.add(addDisposableListener(button, 'click', action));
	}
}

function hiddenRange(range: LineRange, region: UnchangedRegion): LineRange | undefined {
	const start = range.startLineNumber + region.revealedAbove;
	const end = range.endLineNumberExclusive - region.revealedBelow;
	return start < end ? new LineRange(start, end) : undefined;
}

function unchangedRegions(diff: LineDiff, options: HideUnchangedRegionsOptions): UnchangedRegion[] {
	if (diff.hunks.length === 0) return [];
	const regions: UnchangedRegion[] = [];
	for (let start = 0; start < diff.rows.length;) {
		if (diff.rows[start].kind !== LineDiffKind.Unchanged) { start++; continue; }
		let end = start + 1;
		while (end < diff.rows.length && diff.rows[end].kind === LineDiffKind.Unchanged) end++;
		// Ash's visible-line projection requires the first logical line to remain present.
		const contextAbove = start === 0 ? 1 : options.contextLineCount;
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
