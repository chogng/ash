import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { TextModelChange } from '../../core/textChange.js';
import type { IRange } from '../../core/range.js';
import type { LanguageTokenPresentation } from '../../tokens/languageTokens.js';
import type { Event } from '../../../../base/common/event.js';
import type { TextModel } from '../../model/textModel.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';

export const ITreeSitterLibraryService = createDecorator<ITreeSitterLibraryService>('treeSitterLibraryService');
export interface TreeSitterSyntaxSession extends IDisposable {
	readonly execution?: 'rust' | 'worker';
	update(change: TextModelChange): void;
	setTabSize(tabSize: number): void;
	request(operation: 'highlight' | 'facts' | 'selection' | 'preview', data: object, signal: AbortSignal): Promise<TreeSitterSyntaxResult>;
}

/** Window-owned background analysis; parser resources and trees never enter the renderer. */
export interface ITreeSitterLibraryService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	supportsLanguage(languageId: string): boolean;
	createSession(model: TextModel): TreeSitterSyntaxSession;
}

export interface TreeSitterTokenStyle extends LanguageTokenPresentation {
	readonly tokenType: string;
	readonly modifiers?: readonly string[];
}

export interface TreeSitterTokenizationMeasure {
	readonly operation: 'parse' | 'query' | 'facts';
	readonly duration: number;
	readonly incremental: boolean;
	readonly completed: boolean;
	readonly lines: number;
}

export interface RelativeToken {
	readonly languageId?: string;
	readonly start: number;
	readonly end: number;
	readonly name: string;
}

export interface TreeSitterFacts {
	readonly folds: readonly { startLineIndex: number; endLineIndex: number; kind?: 'comment' | 'region'; }[];
	readonly symbols: readonly { name: string; kind: string; range: IRange; selectionRange: IRange; }[];
	readonly diagnostics: readonly { range: IRange; missing: boolean; }[];
}
export interface TreeSitterBracket {
	readonly range: IRange;
	readonly opening: IRange;
	readonly closing?: IRange;
	readonly text: string;
	readonly closeText?: string;
	readonly level: number;
	readonly equalLevel: number;
	readonly minIndent: number;
}
export interface TreeSitterSyntaxResult {
	readonly brackets?: readonly TreeSitterBracket[];
	readonly revision: number;
	readonly rows?: readonly { row: number; tokens: readonly RelativeToken[]; }[];
	readonly facts?: TreeSitterFacts;
	readonly selections?: readonly IRange[];
	readonly preview?: readonly (readonly import('../../tokens/languageTokens.js').LanguageToken[])[];
	readonly measures: readonly TreeSitterTokenizationMeasure[];
}


export const treeSitterChannel = { protocol: 'ash.editor.treeSitter', version: 1 } as const;
