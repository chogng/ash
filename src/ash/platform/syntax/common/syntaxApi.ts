import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';
import type { Event } from '../../../base/common/event.js';

import { syntaxLanguageDefinitions } from './syntaxLanguages.generated.js';

export type SyntaxLanguage = typeof syntaxLanguageDefinitions[number]['id'];
export const syntaxLanguages: readonly SyntaxLanguage[] = syntaxLanguageDefinitions.map(language => language.id);
export const syntaxEditorLanguageIds: readonly string[] = syntaxLanguageDefinitions.flatMap(language => [...language.editorIds]);
const aliases = new Map<string, SyntaxLanguage>();
const editorLanguages = new Map<SyntaxLanguage, string>();
for (const language of syntaxLanguageDefinitions) {
	for (const id of [language.id, ...language.editorIds, ...language.aliases]) aliases.set(id, language.id);
	editorLanguages.set(language.id, language.editorLanguage);
}

/** Normalize editor IDs and code-fence aliases before crossing the syntax boundary. */
export function syntaxLanguageForEditorLanguage(languageId: string): SyntaxLanguage | undefined {
	return aliases.get(languageId.toLowerCase());
}

/** Resolve the editor configuration for an embedded parser. */
export function editorLanguageForSyntaxLanguage(language: SyntaxLanguage): string {
	return editorLanguages.get(language)!;
}

export interface SyntaxPosition {
	readonly lineIndex: number;
	readonly columnIndex: number;
}

export interface SyntaxRange {
	readonly start: SyntaxPosition;
	readonly end: SyntaxPosition;
}

export type SyntaxTokenKind = 'attribute' | 'comment' | 'constant' | 'constructor' | 'embedded' | 'function' | 'keyword' | 'label' | 'module' | 'number' | 'operator' | 'property' | 'punctuation' | 'string' | 'type' | 'variable';

export interface SyntaxToken {
	readonly range: SyntaxRange;
	readonly kind: SyntaxTokenKind;
}

export interface SyntaxFoldingRange {
	readonly range: SyntaxRange;
}

export interface SyntaxSelectionRange {
	readonly range: SyntaxRange;
}

export type SyntaxSymbolKind = 'constant' | 'enum' | 'field' | 'function' | 'macro' | 'method' | 'module' | 'static' | 'struct' | 'trait' | 'type' | 'variable';

export interface SyntaxSymbol {
	readonly name: string;
	readonly kind: SyntaxSymbolKind;
	readonly range: SyntaxRange;
	readonly selectionRange: SyntaxRange;
}

export interface SyntaxDiagnostic {
	readonly range: SyntaxRange;
	readonly kind: 'error' | 'missing';
}

export interface SyntaxOpenParams {
	readonly documentId: string;
	readonly language: SyntaxLanguage;
	readonly revision: number;
	readonly text: string;
}

export interface SyntaxEdit {
	readonly startOffset: number;
	readonly endOffset: number;
	readonly text: string;
}

export interface SyntaxUpdateParams {
	readonly documentId: string;
	readonly previousRevision: number;
	/** Strictly newer host version; edits composed into one batch may skip versions. */
	readonly revision: number;
	readonly edits: readonly SyntaxEdit[];
}

export interface SyntaxAnalyzeParams {
	readonly documentId: string;
	readonly revision: number;
}

export interface SyntaxAnalyzeResult {
	readonly revision: number;
	readonly hasErrors: boolean;
	readonly tokens: readonly SyntaxToken[];
	readonly foldingRanges: readonly SyntaxFoldingRange[];
	readonly symbols: readonly SyntaxSymbol[];
	readonly diagnostics: readonly SyntaxDiagnostic[];
}

export interface SyntaxSelectionRangesParams extends SyntaxAnalyzeParams {
	readonly ranges: readonly SyntaxRange[];
}

export interface SyntaxSelectionRangesResult {
	readonly revision: number;
	readonly ranges: readonly SyntaxSelectionRange[];
}

export interface SyntaxCloseParams {
	readonly documentId: string;
}

/** Viewport queries and bulk facts share the already synchronized parser document. */
export interface SyntaxQueryParams extends SyntaxAnalyzeParams {
	readonly kind: 'highlight' | 'facts' | 'preview';
	readonly factsRevision?: number;
	readonly factsTabSize?: number;
	readonly ranges: readonly { startLineIndex: number; endLineIndex: number; }[];
	readonly tabSize: number;
	readonly lineIndex?: number;
	readonly lines: readonly string[];
}
export interface SyntaxQueryResult {
	readonly revision: number;
	readonly rows: readonly { row: number; tokens: readonly { start: number; end: number; name: string; languageId?: string | null; }[]; }[];
	readonly facts: SyntaxFactsDelta | null;
	readonly brackets: readonly { range: SyntaxRange; opening: SyntaxRange; closing: SyntaxRange | null; text: string; closeText: string | null; level: number; equalLevel: number; minIndent: number; }[];
	readonly parseMs: number;
	readonly queryMs: number;
	readonly incremental: boolean;
}

/** A source-ordered replacement after translating the previous result through text edits. */
export interface SyntaxFactsSplice<T> {
	readonly start: number;
	readonly deleteCount: number;
	readonly items: readonly T[];
}
export interface SyntaxEditorFold {
	readonly startLineIndex: number;
	readonly endLineIndex: number;
	readonly kind?: 'comment' | 'region';
}
export interface SyntaxFactsDelta {
	readonly baseRevision: number | null;
	readonly edits: readonly { range: SyntaxRange; end: SyntaxPosition; }[];
	readonly symbols: SyntaxFactsSplice<SyntaxSymbol>;
	readonly folds: SyntaxFactsSplice<SyntaxEditorFold>;
	readonly diagnostics: SyntaxFactsSplice<SyntaxDiagnostic>;
}

/** Transport-neutral entry point for bounded, authoritative source syntax analysis. */
export interface ISyntaxApi {
	readonly generation: number;
	/** Only an initialized connection can own a Rust syntax document. */
	readonly isAvailable: boolean;
	/** Availability changes invalidate derived handles; the editor retains its text and history. */
	readonly onDidChangeConnection: Event<void>;
	open(params: SyntaxOpenParams, analysis?: 'shared'): Promise<void>;
	update(params: SyntaxUpdateParams): Promise<void>;
	query(params: SyntaxQueryParams, signal: AbortSignal): Promise<SyntaxQueryResult>;
	analyze(params: SyntaxAnalyzeParams): Promise<SyntaxAnalyzeResult>;
	selectionRanges(params: SyntaxSelectionRangesParams): Promise<SyntaxSelectionRangesResult>;
	close(params: SyntaxCloseParams): Promise<void>;
}

export const ISyntaxApi = createServiceIdentifier<ISyntaxApi>('syntaxApi');
