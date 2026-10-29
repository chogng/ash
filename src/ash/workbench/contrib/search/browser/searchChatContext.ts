import type { ChatContextAttachment } from '../../../services/chat/common/chatContextService.js';
import type { IChatContextValueItem } from '../../chat/browser/attachments/chatContextPickService.js';
import type { IChatWidget } from '../../chat/browser/chat.js';
import { Schemas } from '../../../../base/common/network.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { pickChatContextItem } from '../../chat/browser/actions/chatContext.js';
import { getWorkspaceSymbols, type ISearchView } from '../common/search.js';
import { SEARCH_VIEW_ID } from '../common/constants.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IChatAttachmentResolveService } from '../../chat/browser/attachments/chatAttachmentResolveService.js';

/** Captures exactly the source range returned by the workspace symbol provider. */
export class SymbolsContextPickerPick implements IChatContextValueItem {
	public readonly type = 'valuePick' as const;
	public readonly icon = Lxicon.code;
	public get label(): string {
		return localize('chat.context.symbols', 'Symbols…');
	}
	constructor(
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IChatAttachmentResolveService private readonly attachments: IChatAttachmentResolveService,
	) {}
	public isEnabled(): boolean {
		return this.languageFeatures.workspaceSymbolProvider.allNoModel().length > 0;
	}
	public async asAttachment(_widget: IChatWidget | undefined, signal: AbortSignal = new AbortController().signal): Promise<ChatContextAttachment | undefined> {
		const selected = await pickChatContextItem(
			this.quickInput,
			localize('chat.context.selectSymbol', 'Search workspace symbols to attach their source'),
			async (query, token) => {
				const controller = new AbortController();
				const cancellation = token.onCancellationRequested(() => controller.abort());
				try {
					if (token.isCancellationRequested) {
						controller.abort();
					}
					const symbols = await getWorkspaceSymbols(this.languageFeatures.workspaceSymbolProvider.allNoModel(), query, controller.signal);
					return symbols.map(symbol => ({
						label: symbol.name,
						description: symbol.containerName,
						detail: `${symbol.resource.path}:${symbol.range.startLineNumber}`,
						symbol,
					}));
				} finally {
					cancellation.dispose();
				}
			},
			signal,
		);
		if (!selected || selected.kind === 'back' || signal.aborted) {
			return undefined;
		}
		const symbol = selected.item.symbol;
		const [attachment] = await this.attachments.resolveSymbolsAttachContext([symbol], signal);
		return attachment && !signal.aborted ? attachment : undefined;
	}
}

/** Search owns the retained result; this entry captures its matches without running another search. */
export class SearchViewResultChatContextPick implements IChatContextValueItem {
	public readonly type = 'valuePick' as const;
	public readonly icon = Lxicon.search;
	public get label(): string {
		return localize('chat.context.searchResults', 'Search Results');
	}
	constructor(@IViewsService private readonly views: IViewsService) {}
	public isEnabled(): boolean {
		return Boolean(this.views.getViewWithId<ISearchView>(SEARCH_VIEW_ID)?.getSearchResultSnapshot());
	}
	public async asAttachment(_widget: IChatWidget | undefined, signal: AbortSignal = new AbortController().signal): Promise<ChatContextAttachment | undefined> {
		const snapshot = this.views.getViewWithId<ISearchView>(SEARCH_VIEW_ID)?.getSearchResultSnapshot();
		if (!snapshot || signal.aborted) {
			return undefined;
		}
		const name = localize('chat.context.searchResultsName', 'Search Results: {0}', snapshot.query);
		const result = `Matches: ${snapshot.matchCount}\n${snapshot.content}`;
		const content = result.length > 100_000 ? result.slice(0, 100_000) + '\n[Additional matches omitted]' : result;
		return {
			id: 'search-results',
			kind: 'searchResults',
			name,
			resource: URI.from({ scheme: Schemas.internal, authority: 'search-results' }),
			resolve: async () => ({ name, content }),
		};
	}
}
