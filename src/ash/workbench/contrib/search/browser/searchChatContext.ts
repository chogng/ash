import { Schemas } from '../../../../base/common/network.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { withSelection } from '../../../../platform/opener/common/opener.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { pickChatContextItem, type ChatContextSelection, type ChatContextSource } from '../../chat/browser/actions/chatContext.js';
import { getWorkspaceSymbols, type ISearchView } from '../common/search.js';
import { SEARCH_VIEW_ID } from '../common/constants.js';
import { readWorkspaceSymbolSource } from './workspaceSymbolNavigation.js';
import { basename, extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileKind, IFileService } from '../../../../platform/files/common/files.js';
import { IFileSearchService } from '../../../../platform/search/common/fileSearch.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { ChatContextAttachment } from '../../../services/chat/common/chatContextService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';

/** Captures resource context when selected so draft handoff and submission use the same snapshot. */
export class FilesAndFoldersPickerPick {
	constructor(
		@IFileService private readonly files: IFileService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@IFileSearchService private readonly search: IFileSearchService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) { }

	public async asAttachment(resource: URI, kind: FileKind, signal: AbortSignal): Promise<ChatContextAttachment> {
		const name = basename(resource) || resource.path;
		let content: string;
		if (kind === FileKind.Directory) {
			const folder = this.workspace.getWorkspace().folders.find(folder => extUri.isEqualOrParent(resource, folder.uri));
			if (!folder) throw new Error(localize('chat.context.folderUnavailable', 'The folder is outside the current workspace'));
			const relative = resource.path.slice(folder.uri.path.replace(/\/$/, '').length).replace(/^\//, '');
			const prefix = relative ? `${relative}/` : '';
			const found = await this.search.glob({ resource: folder.uri, target: { type: 'workspace', dirId: folder.id } }, { includePatterns: prefix ? [`${prefix.replace(/[\\*?{}[\]]/g, '\\$&')}**`] : [], excludePatterns: [], maxResults: 1000 }, signal);
			// The current Turn contract accepts text context. A directory carries its scope and a bounded manifest, not copies of every file.
			content = `Directory: ${resource.toString()}\nFiles:\n${found.matches.map(file => file.path.slice(prefix.length)).join('\n')}`;
			if (found.totalMatches > found.matches.length) content += `\n… (${found.totalMatches - found.matches.length} additional files)`;
		} else {
			const copy = this.workingCopies.get(resource).find(candidate => candidate.backupKind === 'text');
			content = copy ? copy.backup() : (await this.files.readFile(resource)).content;
			if (content.includes('\0') || !content.trim()) throw new Error(localize('chat.context.invalidText', '{0} must contain nonempty UTF-8 text', name));
		}
		return { id: `file:${extUri.getComparisonKey(resource)}`, kind: kind === FileKind.Directory ? 'directory' : 'file', resource, name, resolve: async () => ({ name, content }) };
	}
}

/** Captures exactly the source range returned by the workspace symbol provider. */
export class SymbolsContextPickerPick implements ChatContextSource {
	public readonly icon = Lxicon.code;
	public get label(): string { return localize('chat.context.symbols', 'Symbols…'); }
	constructor(
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IFileService private readonly files: IFileService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
	) { }
	public isEnabled(): boolean { return this.languageFeatures.workspaceSymbolProvider.allNoModel().length > 0; }
	public async asAttachment(signal: AbortSignal): Promise<ChatContextSelection | undefined> {
		const selected = await pickChatContextItem(this.quickInput, localize('chat.context.selectSymbol', 'Search workspace symbols to attach their source'), async (query, token) => {
			const controller = new AbortController();
			const cancellation = token.onCancellationRequested(() => controller.abort());
			try {
				if (token.isCancellationRequested) { controller.abort(); }
				const symbols = await getWorkspaceSymbols(this.languageFeatures.workspaceSymbolProvider.allNoModel(), query, controller.signal);
				return symbols.map(symbol => ({ label: symbol.name, description: symbol.containerName, detail: `${symbol.resource.path}:${symbol.range.startLineNumber}`, symbol }));
			} finally {
				cancellation.dispose();
			}
		}, signal);
		if (!selected || selected.kind === 'back' || signal.aborted) { return undefined; }
		const symbol = selected.item.symbol;
		const source = await readWorkspaceSymbolSource(symbol, this.files, this.workingCopies);
		if (signal.aborted) { return undefined; }
		if (source === undefined) { throw new Error(localize('chat.context.symbolChanged', 'The symbol source changed. Search again to attach its current code.')); }
		const data = symbol.data as { source?: unknown; declarationRange?: unknown; } | undefined;
		// Local symbol search also supplies its declaration body; navigation keeps the identifier range.
		const range = data?.source === 'codebaseSymbols' && Range.isIRange(data.declarationRange) ? Range.lift(data.declarationRange) : symbol.range;
		const lines = source.split(/\r\n|\r|\n/);
		const first = lines[range.startLineNumber - 1];
		const last = lines[range.endLineNumber - 1];
		if (first === undefined || last === undefined || range.startColumn < 1 || range.endColumn < 1 || range.startColumn > first.length + 1 || range.endColumn > last.length + 1) {
			throw new Error(localize('chat.context.symbolRangeUnavailable', 'The symbol source range is no longer available'));
		}
		const code = range.startLineNumber === range.endLineNumber
			? first.slice(range.startColumn - 1, range.endColumn - 1)
			: [first.slice(range.startColumn - 1), ...lines.slice(range.startLineNumber, range.endLineNumber - 1), last.slice(0, range.endColumn - 1)].join('\n');
		if (!code.trim()) { throw new Error(localize('chat.context.symbolEmpty', 'The symbol has no source text to attach')); }
		const resource = withSelection(symbol.resource, { startLineNumber: range.startLineNumber, startColumn: range.startColumn, endLineNumber: range.endLineNumber, endColumn: range.endColumn });
		const name = symbol.name;
		const content = `Symbol: ${name}\nSource: ${resource.toString()}\n\n${code.length > 100_000 ? code.slice(0, 100_000) + '\n[Additional code omitted]' : code}`;
		return { acceptInBackground: selected.background, attachment: { id: `symbol:${resource.toString()}:${name}`, kind: 'symbol', resource, name, resolve: async () => ({ name, content }) } };
	}
}

/** Search owns the retained result; this entry captures its matches without running another search. */
export class SearchViewResultChatContextPick implements ChatContextSource {
	public readonly icon = Lxicon.search;
	public get label(): string { return localize('chat.context.searchResults', 'Search Results'); }
	constructor(@IViewsService private readonly views: IViewsService) { }
	public isEnabled(): boolean { return Boolean(this.views.getViewWithId<ISearchView>(SEARCH_VIEW_ID)?.getSearchResultSnapshot()); }
	public async asAttachment(signal: AbortSignal): Promise<ChatContextSelection | undefined> {
		const snapshot = this.views.getViewWithId<ISearchView>(SEARCH_VIEW_ID)?.getSearchResultSnapshot();
		if (!snapshot || signal.aborted) { return undefined; }
		const name = localize('chat.context.searchResultsName', 'Search Results: {0}', snapshot.query);
		const result = `Matches: ${snapshot.matchCount}\n${snapshot.content}`;
		const content = result.length > 100_000 ? result.slice(0, 100_000) + '\n[Additional matches omitted]' : result;
		return {
			acceptInBackground: false, attachment: {
				id: 'search-results', kind: 'searchResults', name,
				resource: URI.from({ scheme: Schemas.internal, authority: 'search-results' }),
				resolve: async () => ({ name, content }),
			}
		};
	}
}
