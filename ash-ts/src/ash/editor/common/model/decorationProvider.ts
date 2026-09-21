import type { Range } from '../core/range.js';
import type { IModelDecoration } from '../model.js';

/** Model-owned decorations computed on demand rather than stored as tracked ranges. */
export interface DecorationProvider {
	getDecorationsInRange(range: Range, ownerId?: number, filterOutValidation?: boolean, filterFontDecorations?: boolean, onlyMinimapDecorations?: boolean): IModelDecoration[];
}
