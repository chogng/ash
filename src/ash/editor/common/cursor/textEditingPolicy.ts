import type { TypeOperations } from './cursorTypeOperations.js';
import type { DeleteOperations } from './cursorDeleteOperations.js';
import type { CursorConfiguration, ICursorSimpleModel } from '../cursorCommon.js';
import type { ITextModel } from '../model.js';
import type { Range } from '../core/range.js';
import type { Selection } from '../core/selection.js';
import type { ICommand } from '../editorCommon.js';
import type { CompleteEnterAction } from '../languages/languageConfiguration.js';
import type { EditorAutoIndentStrategy } from '../config/editorOptions.js';
import type { ILanguageConfigurationService } from '../languages/languageConfigurationRegistry.js';

/** Optional synchronous editing decisions; commands still commit through the model's single transaction/history. */
export interface ITextEditingPolicy {
	readonly typeWithInterceptors: typeof TypeOperations.typeWithInterceptors;
	readonly compositionEndWithInterceptors: typeof TypeOperations.compositionEndWithInterceptors;
	readonly isAutoClosingPairDelete: typeof DeleteOperations.isAutoClosingPairDelete;
	deleteAutoClosedPair(
		config: CursorConfiguration,
		model: ICursorSimpleModel,
		selections: Selection[],
		autoClosedCharacters: Range[],
	): [boolean, Array<ICommand | null>] | undefined;
	getEnterAction(
		strategy: EditorAutoIndentStrategy,
		model: ITextModel,
		range: Range,
		configurations: ILanguageConfigurationService,
	): CompleteEnterAction | null;
}
