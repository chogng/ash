import { URI } from '../../../base/common/uri.js';
import { Position } from '../core/position.js';
import { Range } from '../core/range.js';
import { Selection } from '../core/selection.js';
import * as standaloneEnums from '../standalone/standaloneEnums.js';

/** Value objects shared by the standalone editor and language APIs. */
export interface IEditorBaseApi {
	readonly URI: typeof URI;
	readonly Position: typeof Position;
	readonly Range: typeof Range;
	readonly Selection: typeof Selection;
	readonly SelectionDirection: typeof standaloneEnums.SelectionDirection;
}

export function createEditorBaseApi(): IEditorBaseApi {
	return Object.freeze({ URI, Position, Range, Selection, SelectionDirection: standaloneEnums.SelectionDirection });
}
