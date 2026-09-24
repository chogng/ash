import { TextMateTokenizationService, type TextMateGrammarSnapshotSource, type TextMateTokenizationServiceOptions } from "../common/textMateTokenizationService.js";
import { createBrowserTextMateOnigLib } from "./textMateOniguruma.js";

/** Creates a caller-owned TextMate service for a browser or dedicated Worker realm. */
export function createBrowserTextMateTokenizationService(grammars: TextMateGrammarSnapshotSource, options: TextMateTokenizationServiceOptions = {}): TextMateTokenizationService {
	return new TextMateTokenizationService(grammars, createBrowserTextMateOnigLib(), options);
}
