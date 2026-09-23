import { toDisposable, Disposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { Position } from '../../../common/core/position.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import type { LanguageDocumentSymbol } from '../../../common/languages.js';
import { TextModel } from '../../../common/model/textModel.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { DocumentSymbolService } from '../../../contrib/documentSymbols/common/languageDocumentSymbols.js';

interface SymbolPick extends IQuickPickItem {
	readonly symbol: LanguageDocumentSymbol;
}

/** Owns one editor's symbol request while its Quick Pick is visible. */
export class StandaloneGotoSymbolQuickAccessProvider extends Disposable {
	constructor(
		private readonly editor: ICodeEditor,
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
	}

	public show(): void {
		const model = this.editor.getModel();
		if (!(model instanceof TextModel)) {
			this.dispose();
			return;
		}

		const picker = this._register(this.quickInput.createQuickPick<SymbolPick>());
		picker.ariaLabel = localize('gotoSymbol.dialog', 'Go to Symbol');
		picker.placeholder = localize('gotoSymbol.placeholder', 'Type a symbol name');
		this._register(picker.onDidHide(() => this.dispose()));
		this._register(picker.onDidBlur(() => this.dispose()));
		this._register(picker.onDidAccept(item => {
			picker.hide();
			this.editor.setSelection(item.symbol.selectionRange, 'editor.action.quickOutline');
			this.editor.revealRange(item.symbol.selectionRange);
		}));

		const request = new AbortController();
		this._register(toDisposable(() => request.abort()));
		const symbols = this._register(new DocumentSymbolService(model, this.languageFeatures.documentSymbolProvider, { resource: model.uri }));
		const close = () => this.dispose();
		this._register(this.editor.onDidChangeModelContent(close));
		this._register(this.editor.onDidChangeModel(close));
		this._register(this.editor.onDidChangeCursorSelection(close));
		this._register(this.editor.onDidDispose(close));
		this._register(model.onDidChangeLanguage(close));
		this._register(this.languageFeatures.documentSymbolProvider.onDidChange(close));
		picker.show();
		void symbols.provideDocumentSymbols(model.getLanguageId(), request.signal).then(result => {
			if (request.signal.aborted) {
				return;
			}
			const flat: LanguageDocumentSymbol[] = [];
			const visit = (symbol: LanguageDocumentSymbol): void => {
				flat.push(symbol);
				symbol.children?.forEach(visit);
			};
			result.forEach(visit);
			flat.sort((left, right) => Position.compare(left.selectionRange.getStartPosition(), right.selectionRange.getStartPosition()));
			picker.items = flat.map(symbol => ({ symbol, label: symbol.name, description: symbol.detail }));
		}).catch(error => {
			if (!request.signal.aborted) {
				this.notifications.error(String(error));
			}
		});
	}
}

export class GotoSymbolAction extends EditorAction {
	public static readonly ID = 'editor.action.quickOutline';

	constructor() {
		super({
			id: GotoSymbolAction.ID,
			label: localize2('gotoSymbol.label', 'Go to Symbol...'),
			precondition: undefined,
			kbOpts: {
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyO,
				weight: KeybindingWeight.EditorContrib,
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
			},
		});
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		accessor.get(IInstantiationService).createInstance(StandaloneGotoSymbolQuickAccessProvider, editor).show();
	}
}

registerEditorAction(GotoSymbolAction);
