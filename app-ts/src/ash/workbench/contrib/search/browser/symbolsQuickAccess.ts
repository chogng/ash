import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { type IQuickAccessProvider } from '../../../../platform/quickinput/common/quickAccess.js';
import type { IQuickPick, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { type LanguageWorkspaceSymbol } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { getWorkspaceSymbols } from '../common/search.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { acceptWorkspaceSymbol } from './workspaceSymbolNavigation.js';

interface WorkspaceSymbolQuickPickItem extends IQuickPickItem {
	readonly symbol: LanguageWorkspaceSymbol;
}

export class SymbolsQuickAccessProvider implements IQuickAccessProvider {
	static readonly PREFIX = '@';

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

function resourceLabel(resource: LanguageWorkspaceSymbol['resource']): string {
	const path = decodeURIComponent(resource.path);
	return path.slice(path.lastIndexOf('/') + 1) || resource.toString();
}
