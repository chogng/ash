import { getWindow, isHTMLElement } from '../../../../base/browser/dom.js';
import { isFiniteNumber, isNonNegativeSafeInteger } from '../../../../base/common/numbers.js';
import { type IMultiDiffEditorModel, validateDocumentDiffItems } from './model.js';
import { type IWorkbenchUIElementFactory } from './workbenchUIElementFactory.js';

export const DEFAULT_LINE_HEIGHT = 20;
export const DEFAULT_OVERSCAN_ROW_COUNT = 8;

/** Inputs supplied by an editor host; file models remain owned by that host. */
export interface IMultiDiffEditorWidgetOptions {
	readonly container: HTMLElement;
	readonly model: IMultiDiffEditorModel;
	readonly lineHeight?: number;
	readonly fontFamily?: string;
	readonly fontSize?: number;
	readonly fontLigatures?: boolean;
	readonly showLineNumbers?: boolean;
	readonly showInlineChanges?: boolean;
	readonly loopChanges?: boolean;
	readonly wordWrap?: boolean;
	readonly overscanRowCount?: number;
	readonly ariaLabel?: string;
	readonly workbenchUIElementFactory?: IWorkbenchUIElementFactory;
}

export function validateMultiDiffEditorOptions(options: IMultiDiffEditorWidgetOptions): void {
	if (!options || typeof options !== 'object' || !isHTMLElement(options.container)) {
		throw new TypeError('Multi-diff editor widget requires a browser container');
	}
	if (!options.model || typeof options.model.onDidChangeItems !== 'function') throw new TypeError('Multi-diff editor widget requires a comparison model');
	validateDocumentDiffItems(options.model.items);
	const lineHeight = options.lineHeight ?? DEFAULT_LINE_HEIGHT;
	const overscanRowCount = options.overscanRowCount ?? DEFAULT_OVERSCAN_ROW_COUNT;
	if (!isFiniteNumber(lineHeight) || lineHeight <= 0) throw new RangeError('Multi-diff editor line height must be positive and finite');
	if (!isNonNegativeSafeInteger(overscanRowCount)) throw new RangeError('Multi-diff editor overscan row count must be a non-negative safe integer');
	if (options.fontFamily !== undefined && (typeof options.fontFamily !== 'string' || !options.fontFamily.trim())) throw new TypeError('Multi-diff editor font family must be a non-empty string');
	if (options.fontSize !== undefined && (!isFiniteNumber(options.fontSize) || options.fontSize <= 0)) throw new RangeError('Multi-diff editor font size must be positive and finite');
	for (const [name, value] of [
		['fontLigatures', options.fontLigatures],
		['showLineNumbers', options.showLineNumbers],
		['showInlineChanges', options.showInlineChanges],
		['loopChanges', options.loopChanges],
		['wordWrap', options.wordWrap],
	] as const) {
		if (value !== undefined && typeof value !== 'boolean') throw new TypeError(`Multi-diff editor option '${name}' must be boolean`);
	}
	if (options.ariaLabel !== undefined && (typeof options.ariaLabel !== 'string' || options.ariaLabel.trim().length === 0)) throw new TypeError('Multi-diff editor ARIA label must be a non-empty string');
	if (options.workbenchUIElementFactory !== undefined && typeof options.workbenchUIElementFactory.createItemActions !== 'function') throw new TypeError('Multi-diff editor Workbench factory must create item actions');
	if (options.container.ownerDocument.defaultView !== getWindow(options.container)) throw new Error('Multi-diff editor container must belong to its owner window');
}
