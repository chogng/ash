import { Keybinding, logicalKey } from "../../../../base/common/keybindings.js";
import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { Action2, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { type ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import { type LanguageWorkspaceSymbol } from '../../../../editor/common/languages.js';
import { getWorkspaceSymbols } from '../../search/common/search.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { IFileService } from "../../../../platform/files/common/files.js";
import { IWorkingCopyService } from "../../../services/workingCopy/common/workingCopyService.js";
import { acceptWorkspaceSymbol } from "./workspaceSymbolNavigation.js";

export const ShowAllSymbolsCommandId = "workbench.action.showAllSymbols";

interface WorkspaceSymbolQuickPickItem extends IQuickPickItem {
	readonly symbol: LanguageWorkspaceSymbol;
}

registerAction2(class ShowAllSymbolsAction extends Action2 {
	constructor() {
		super({
			id: ShowAllSymbolsCommandId,
			title: "Go to Symbol in Workspace",
			f1: true,
			keybinding: { primary: Keybinding.single(logicalKey("t", { primaryKey: true })) },
		});
	}

	override run(accessor: ServicesAccessor): void {
		const providers = accessor.get(ILanguageFeaturesService).workspaceSymbolProvider;
		const editor = accessor.get(IEditorService);
		const files = accessor.get(IFileService);
		const workingCopies = accessor.get(IWorkingCopyService);
		const quickPick = accessor.get(IQuickInputService).createQuickPick<WorkspaceSymbolQuickPickItem>();
		const disposables = new DisposableStore();
		let request: AbortController | undefined;
		let requestGeneration = 0;
		disposables.add(quickPick);
		quickPick.placeholder = "Type the name of a symbol in the workspace";

		const update = (query: string): void => {
			request?.abort();
			const current = request = new AbortController();
			const generation = ++requestGeneration;
			const publish = (symbols: readonly LanguageWorkspaceSymbol[]): void => {
				if (current.signal.aborted || generation !== requestGeneration) return;
				quickPick.items = symbols.map(symbol => ({
					symbol,
					label: symbol.name,
					description: symbol.containerName,
					detail: `${resourceLabel(symbol.resource)}:${symbol.range.startLineNumber}`,
				}));
			};
			void getWorkspaceSymbols(providers.allNoModel(), query, current.signal, publish).then(publish).catch(error => {
				if (!current.signal.aborted) console.error("Workspace symbol search failed", error);
			});
		};

		disposables.add(quickPick.onDidChangeValue(update));
		disposables.add(quickPick.onDidAccept(item => void acceptWorkspaceSymbol(item.symbol, files, workingCopies, editor, quickPick, () => update(quickPick.value))));
		disposables.add(quickPick.onDidHide(() => { request?.abort(); disposables.dispose(); }));
		quickPick.show();
		update("");
	}
});

function resourceLabel(resource: LanguageWorkspaceSymbol["resource"]): string {
	const path = decodeURIComponent(resource.path);
	return path.slice(path.lastIndexOf("/") + 1) || resource.toString();
}
