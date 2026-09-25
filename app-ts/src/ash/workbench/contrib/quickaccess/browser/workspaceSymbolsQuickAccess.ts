import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickAccessController, QuickAccessRegistry, type IQuickAccessProvider } from '../../../../platform/quickinput/common/quickAccess.js';
import type { IQuickPick, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { type LanguageWorkspaceSymbol } from '../../../../editor/common/languages.js';
import { localize, localize2 } from '../../../../nls.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { getWorkspaceSymbols } from '../../search/common/search.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { acceptWorkspaceSymbol } from './workspaceSymbolNavigation.js';

export const ShowAllSymbolsCommandId = 'workbench.action.showAllSymbols';

interface WorkspaceSymbolQuickPickItem extends IQuickPickItem {
	readonly symbol: LanguageWorkspaceSymbol;
}

class WorkspaceSymbolsQuickAccessProvider implements IQuickAccessProvider {
	constructor(
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
		@IEditorService private readonly editor: IEditorService,
		@IFileService private readonly files: IFileService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
	) {}

	provide(picker: IQuickPick<IQuickPickItem>, prefix: string, signal: AbortSignal): DisposableStore {
		const disposables = new DisposableStore();
		let request: AbortController | undefined;
		let requestGeneration = 0;
		const update = (value: string): void => {
			request?.abort();
			const current = request = new AbortController();
			const generation = ++requestGeneration;
			const publish = (symbols: readonly LanguageWorkspaceSymbol[]): void => {
				if (signal.aborted || current.signal.aborted || generation !== requestGeneration) return;
				picker.items = symbols.map(symbol => ({
					symbol,
					label: symbol.name,
					description: symbol.containerName,
					detail: `${resourceLabel(symbol.resource)}:${symbol.range.startLineNumber}`,
				}));
			};
			void getWorkspaceSymbols(this.languageFeatures.workspaceSymbolProvider.allNoModel(), value.slice(prefix.length), current.signal, publish)
				.then(publish)
				.catch(error => { if (!current.signal.aborted && !signal.aborted) console.error('Workspace symbol search failed', error); });
		};
		disposables.add(picker.onDidChangeValue(update));
		disposables.add(picker.onDidAccept(item => {
			void acceptWorkspaceSymbol((item as WorkspaceSymbolQuickPickItem).symbol, this.files, this.workingCopies, this.editor, picker, () => update(picker.value));
		}));
		disposables.add(toDisposable(() => request?.abort()));
		update(picker.value);
		return disposables;
	}
}

QuickAccessRegistry.register({
	prefix: '@',
	get placeholder() { return localize('quickAccess.symbolPlaceholder', 'Type the name of a symbol in the workspace'); },
	get helpLabel() { return localize('quickAccess.workspaceSymbols', 'Symbols in Workspace'); },
	ctor: WorkspaceSymbolsQuickAccessProvider,
});

registerAction2(class ShowAllSymbolsAction extends Action2 {
	constructor() {
		super({
			id: ShowAllSymbolsCommandId,
			get title() { return localize2('quickAccess.goToWorkspaceSymbol', 'Go to Symbol in Workspace'); },
			f1: true,
			keybinding: { primary: Keybinding.single(logicalKey('t', { primaryKey: true })) },
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IQuickAccessController).show('@');
	}
});

function resourceLabel(resource: LanguageWorkspaceSymbol['resource']): string {
	const path = decodeURIComponent(resource.path);
	return path.slice(path.lastIndexOf('/') + 1) || resource.toString();
}
