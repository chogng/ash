import type { URI } from '../../base/common/uri.js';
import type { ITextEditorOptions } from '../../platform/editor/common/editor.js';
import type { IRange } from './core/range.js';

/** A comparison is identified by its content resources, including an absent side. */
export interface IMultiDiffResourceId {
	readonly original: URI | undefined;
	readonly modified: URI | undefined;
}

export interface IMultiDiffEditorOptionsViewState {
	readonly revealData?: { readonly resource: IMultiDiffResourceId; readonly range?: IRange };
}

export interface IMultiDiffEditorOptions extends ITextEditorOptions {
	readonly viewState?: IMultiDiffEditorOptionsViewState;
}
