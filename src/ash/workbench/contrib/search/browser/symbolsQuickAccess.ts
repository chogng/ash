import { DisposableStore } from '../../../../base/common/lifecycle.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import {
	PickerQuickAccessProvider,
	type IPickerQuickAccessItem,
	type Picks,
} from '../../../../platform/quickinput/browser/pickerQuickAccess.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { type LanguageWorkspaceSymbol } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { getWorkspaceSymbols } from '../common/search.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { acceptWorkspaceSymbol } from './workspaceSymbolNavigation.js';

export class SymbolsQuickAccessProvider extends PickerQuickAccessProvider<IPickerQuickAccessItem> {
	static readonly PREFIX = '@';

	constructor(
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
		@IEditorService private readonly editor: IEditorService,
		@IFileService private readonly files: IFileService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) {
		super(SymbolsQuickAccessProvider.PREFIX);
	}

	protected override async _getPicks(
		filter: string,
		resources: DisposableStore,
		token: CancellationToken,
	): Promise<Picks<IPickerQuickAccessItem>> {
		const controller = new AbortController();
		resources.add(token.onCancellationRequested(() => controller.abort()));
		if (token.isCancellationRequested) controller.abort();
		const picksFor = (symbols: readonly LanguageWorkspaceSymbol[]): IPickerQuickAccessItem[] =>
			symbols.map(symbol => ({
				label: symbol.name,
				description: symbol.containerName,
				detail: `${resourceLabel(symbol.resource)}:${symbol.range.startLineNumber}`,
				// Revision checks can refresh stale symbols; close only after that check succeeds.
				keepOpen: true,
				accept: () => {
					const picker = this.quickInput.currentQuickInput;
					if (!picker) return;
					void acceptWorkspaceSymbol(symbol, this.files, this.workingCopies, this.editor, picker, () =>
						this.refresh(),
					);
				},
			}));
		const symbols = await getWorkspaceSymbols(
			this.languageFeatures.workspaceSymbolProvider.allNoModel(),
			filter,
			controller.signal,
			symbols => this.updatePicks(picksFor(symbols), token),
		);
		return picksFor(symbols);
	}
}

function resourceLabel(resource: LanguageWorkspaceSymbol['resource']): string {
	const path = resource.path;
	return path.slice(path.lastIndexOf('/') + 1) || resource.toString();
}
