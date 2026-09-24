import { Position } from "../../../../editor/common/core/position.js";
import { Range } from "../../../../editor/common/core/range.js";
import type { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import type { LanguageWorkspaceSymbol, LanguageWorkspaceSymbolProvider } from '../../../../editor/common/languages.js';
import { workspaceResourceFromPath } from "../../../../platform/files/browser/fileService.js";
import type { ICodebaseSymbolsService, CodebaseSymbolsMatch } from "../../../../platform/codebaseSymbols/common/codebaseSymbolsService.js";
import type { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";

const MAX_WORKSPACE_SYMBOL_RESULTS = 100;

/** Registers the local syntax declaration projection as one Workspace Symbol provider. */
export function registerCodebaseSymbolsWorkspaceSymbolProvider(languageFeatures: ILanguageFeaturesService, symbols: ICodebaseSymbolsService, workspace: IWorkspaceContextService) {
	return languageFeatures.workspaceSymbolProvider.register('*', new CodebaseSymbolsWorkspaceSymbolProvider(symbols, workspace));
}

class CodebaseSymbolsWorkspaceSymbolProvider implements LanguageWorkspaceSymbolProvider {
	constructor(private readonly symbols: ICodebaseSymbolsService, private readonly workspace: IWorkspaceContextService) {}

	async provideWorkspaceSymbols(query: string, signal: AbortSignal): Promise<readonly LanguageWorkspaceSymbol[]> {
		const root = singleWorkspaceRoot(this.workspace);
		if (!root) return Object.freeze([]);
		const result = await this.symbols.search(query, MAX_WORKSPACE_SYMBOL_RESULTS, signal);
		return Object.freeze(result.matches.flatMap(match => {
			const resource = workspaceResourceFromPath(root, match.path);
			if (!resource) return [];
			return [Object.freeze({
				name: match.name,
				kind: match.kind,
				resource,
				range: textRange(match),
				...(match.containerName === undefined ? {} : { containerName: match.containerName }),
				data: Object.freeze({ source: "codebaseSymbols", score: match.score, sourceRevision: match.sourceRevision, matchedIndices: match.matchedIndices }),
			})];
		}));
	}
}

function singleWorkspaceRoot(workspace: IWorkspaceContextService) {
	const folders = workspace.getWorkspace().folders;
	return folders.length === 1 ? folders[0]?.uri : undefined;
}

function textRange(match: CodebaseSymbolsMatch): Range {
	return Range.fromPositions(
		new Position(match.selectionRange.start.lineIndex + 1, match.selectionRange.start.columnIndex + 1),
		new Position(match.selectionRange.end.lineIndex + 1, match.selectionRange.end.columnIndex + 1),
	);
}
