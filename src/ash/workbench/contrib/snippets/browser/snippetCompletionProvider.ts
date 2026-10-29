import { Disposable } from '../../../../base/common/lifecycle.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import {
	LanguageCompletionItemKind,
	LanguageCompletionInsertTextFormat,
	type LanguageCompletionProvider,
	type LanguageCompletionProviderRequest,
	type LanguageCompletionProviderResult,
} from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ISnippetsService } from './snippets.js';

export class SnippetCompletionProvider extends Disposable implements LanguageCompletionProvider {
	public readonly id = 'workbench.snippets';
	public readonly languageIds = ['*'];

	constructor(
		@ISnippetsService private readonly snippets: ISnippetsService,
		@ILanguageFeaturesService features: ILanguageFeaturesService,
	) {
		super();
		const registration = this._register(features.completionProvider.registerGroup([this]));
		this._register(snippets.onDidChange(() => registration.replace([this])));
	}

	public provideCompletions(
		request: LanguageCompletionProviderRequest,
		signal: AbortSignal,
	): LanguageCompletionProviderResult | undefined {
		this.assertNotDisposed();
		signal.throwIfAborted();
		const line = request.snapshot.getText().split('\n')[request.position.lineNumber - 1];
		const before = line.slice(0, request.position.column - 1);
		const items: NonNullable<LanguageCompletionProviderResult>['items'][number][] = [];
		for (const snippet of this.snippets.getSnippetsSync(request.languageId)) {
			if (!snippet.prefix) {
				continue;
			}
			const lowerPrefix = snippet.prefix.toLowerCase();
			for (let length = Math.min(before.length, snippet.prefix.length); length > 0; length--) {
				const start = before.length - length;
				if (
					!lowerPrefix.startsWith(before.slice(start).toLowerCase()) ||
					(start > 0 && /[\p{L}\p{N}_]/u.test(before[start - 1]))
				) {
					continue;
				}
				items.push({
					id: snippet.snippetIdentifier,
					label: snippet.prefix,
					kind: LanguageCompletionItemKind.Snippet,
					range: Range.fromPositions(new Position(request.position.lineNumber, start + 1), request.position),
					insertText: snippet.body,
					insertTextFormat: LanguageCompletionInsertTextFormat.Snippet,
					detail: snippet.description || snippet.name,
					sortText: snippet.prefix,
				});
				break;
			}
		}
		return items.length === 0 ? undefined : { items, isIncomplete: false };
	}
}
