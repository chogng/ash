import { getWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { isFiniteNumber } from '../../../../base/common/numbers.js';
import { type HideUnchangedRegionsOptions, diffEditorDefaultOptions } from '../../../common/config/diffEditor.js';
import { type DiffModel } from '../../../common/diff/diffModel.js';
import type { IDiffEditorOptions } from '../../../common/config/editorOptions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

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
	readonly renderSideBySideInlineBreakpoint?: number;
	readonly enableSplitViewResizing?: boolean;
	readonly splitViewDefaultRatio?: number;
	readonly renderMarginRevertIcon?: boolean;
	readonly renderGutterMenu?: boolean;
	readonly renderOverviewRuler?: boolean;
	readonly experimental?: IDiffEditorOptions['experimental'];
}

/** Owns the mutable presentation choices shared by Diff layout and its editors. */
export class DiffEditorOptions {
	private configuredWordWrap: boolean;
	private temporaryWordWrap: boolean | undefined;
	private renderSideBySide: boolean;
	private useInlineViewWhenSpaceIsLimited: boolean;
	private inlineBreakpoint: number;
	private splitViewResizingEnabled: boolean;
	private defaultSplitViewRatio: number;
	private featureOptions: IDiffEditorOptions;

	constructor(options: DiffEditorWidgetOptions, @IConfigurationService private readonly configuration: IConfigurationService) {
		validateOptions(options);
		this.configuredWordWrap = options.wordWrap ?? false;
		this.renderSideBySide = options.renderSideBySide ?? true;
		this.useInlineViewWhenSpaceIsLimited = options.useInlineViewWhenSpaceIsLimited ?? false;
		this.inlineBreakpoint = options.renderSideBySideInlineBreakpoint ?? diffEditorDefaultOptions.renderSideBySideInlineBreakpoint;
		this.splitViewResizingEnabled = options.enableSplitViewResizing ?? diffEditorDefaultOptions.enableSplitViewResizing;
		this.defaultSplitViewRatio = options.splitViewDefaultRatio ?? diffEditorDefaultOptions.splitViewDefaultRatio;
		this.featureOptions = {
			renderMarginRevertIcon: options.renderMarginRevertIcon,
			renderGutterMenu: options.renderGutterMenu,
			renderOverviewRuler: options.renderOverviewRuler,
			experimental: options.experimental,
		};
	}

	public get renderMarginRevertIcon(): boolean {
		return this.featureOptions.renderMarginRevertIcon ?? this.configuration.getValue<boolean>('diffEditor.renderMarginRevertIcon');
	}

	public get renderGutterMenu(): boolean {
		return this.featureOptions.renderGutterMenu ?? this.configuration.getValue<boolean>('diffEditor.renderGutterMenu');
	}

	public get renderOverviewRuler(): boolean {
		return this.featureOptions.renderOverviewRuler ?? this.configuration.getValue<boolean>('diffEditor.renderOverviewRuler');
	}

	public get showMoves(): boolean {
		return this.featureOptions.experimental?.showMoves ?? this.configuration.getValue<boolean>('diffEditor.experimental.showMoves');
	}

	public updateOptions(options: IDiffEditorOptions): void {
		this.featureOptions = { ...this.featureOptions, ...options, experimental: { ...this.featureOptions.experimental, ...options.experimental } };
	}

	public get wordWrap(): boolean {
		return this.temporaryWordWrap ?? this.configuredWordWrap;
	}

	public get enableSplitViewResizing(): boolean {
		return this.splitViewResizingEnabled;
	}

	public get splitViewDefaultRatio(): number {
		return this.defaultSplitViewRatio;
	}

	public setConfiguredWordWrap(enabled: boolean): void {
		this.configuredWordWrap = enabled;
	}

	public toggleWordWrap(): void {
		this.temporaryWordWrap = this.temporaryWordWrap === undefined ? !this.wordWrap : undefined;
	}

	public setViewMode(renderSideBySide: boolean, useInlineViewWhenSpaceIsLimited: boolean, inlineBreakpoint: number): void {
		if (!Number.isSafeInteger(inlineBreakpoint) || inlineBreakpoint < 0) {
			throw new RangeError('Diff editor inline breakpoint must be a non-negative integer');
		}
		this.renderSideBySide = renderSideBySide;
		this.useInlineViewWhenSpaceIsLimited = useInlineViewWhenSpaceIsLimited;
		this.inlineBreakpoint = inlineBreakpoint;
	}

	public setSplitViewOptions(enabled: boolean, defaultRatio: number): void {
		if (typeof enabled !== 'boolean') throw new TypeError('Diff editor split view resizing must be boolean');
		validateSplitViewRatio(defaultRatio);
		this.splitViewResizingEnabled = enabled;
		this.defaultSplitViewRatio = defaultRatio;
	}

	public isInlineView(width: number): boolean {
		return !this.renderSideBySide || (this.useInlineViewWhenSpaceIsLimited && width <= this.inlineBreakpoint);
	}
}

function validateOptions(options: DiffEditorWidgetOptions): void {
	if (!options || typeof options !== 'object' || !isHTMLElement(options.container)) {
		throw new TypeError('Diff editor widget requires a browser container');
	}
	if (!options.model || typeof options.model !== 'object') throw new TypeError('Diff editor widget requires a diff model');
	if (options.lineHeight !== undefined && (!isFiniteNumber(options.lineHeight) || options.lineHeight <= 0)) {
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
		['enableSplitViewResizing', options.enableSplitViewResizing],
		['renderMarginRevertIcon', options.renderMarginRevertIcon],
		['renderGutterMenu', options.renderGutterMenu],
		['renderOverviewRuler', options.renderOverviewRuler],
		['experimental.showMoves', options.experimental?.showMoves],
	] as const) {
		if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`Diff editor option '${name}' must be boolean`);
	}
	if (options.renderSideBySideInlineBreakpoint !== undefined
		&& (!Number.isSafeInteger(options.renderSideBySideInlineBreakpoint) || options.renderSideBySideInlineBreakpoint < 0)) {
		throw new RangeError('Diff editor inline breakpoint must be a non-negative integer');
	}
	if (options.splitViewDefaultRatio !== undefined) validateSplitViewRatio(options.splitViewDefaultRatio);
	if (options.container.ownerDocument.defaultView !== getWindow(options.container)) {
		throw new Error('Diff editor widget container must belong to its owner window');
	}
}

function validateSplitViewRatio(ratio: number): void {
	if (!isFiniteNumber(ratio) || ratio < 0.1 || ratio > 0.9) {
		throw new RangeError('Diff editor split view default ratio must be between 0.1 and 0.9');
	}
}
