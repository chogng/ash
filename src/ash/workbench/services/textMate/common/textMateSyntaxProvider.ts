import { type SyntaxProvider, type SyntaxProviderRequest, type SyntaxTokenizationRequest } from '../../../../editor/common/languages.js';
import { type LanguageWorkerDocumentSynchronization } from '../../../../editor/common/services/textModelSync/textModelSync.protocol.js';
import { TextMateTokenizationService } from "./textMateTokenizationService.js";

export const TEXTMATE_SYNTAX_PROVIDER_ID = "textmate.grammar";
export const TEXTMATE_TOKEN_PRIORITY = 100;

/** Adapts one caller-owned TextMate runtime to Stanza's Syntax provider contract. */
export function createTextMateSyntaxProvider(tokenization: TextMateTokenizationService): SyntaxProvider {
	if (!(tokenization instanceof TextMateTokenizationService)) {
		throw new TypeError("TextMate syntax provider requires a tokenization service");
	}
	return Object.freeze({
		id: TEXTMATE_SYNTAX_PROVIDER_ID,
		languageIds: Object.freeze(["*"]),
		tokenPriority: TEXTMATE_TOKEN_PRIORITY,
		provideTokens: (request: SyntaxProviderRequest, signal: AbortSignal) => tokenization.tokenize(request.languageId, request.snapshot, signal),
		provideTokensForLines: (request: SyntaxTokenizationRequest, signal: AbortSignal) => tokenization.tokenizeLinesAt(request.languageId, request.snapshot, request.tokenize.lineNumber, request.tokenize.lines, signal),
		synchronizeDocument: (synchronization: LanguageWorkerDocumentSynchronization) => tokenization.synchronizeDocument(synchronization),
	});
}
