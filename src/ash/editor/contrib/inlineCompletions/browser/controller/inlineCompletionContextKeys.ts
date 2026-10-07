import { RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';

export abstract class InlineCompletionContextKeys {
	public static readonly inlineSuggestionVisible = new RawContextKey<boolean>('inlineSuggestionVisible', false);
}
