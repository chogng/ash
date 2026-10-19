import { toDisposable, Disposable } from '../../../../../src/ash/base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../src/ash/nls.js';
import { KeyCode, KeyMod } from '../../../../../src/ash/base/common/keyCodes.js';
import { IInstantiationService } from '../../../../../src/ash/platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../../src/ash/platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../../src/ash/platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../src/ash/platform/quickinput/common/quickInput.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../registration.js';
import type { ICodeEditor } from '../../../../../src/ash/editor/browser/editorBrowser.js';
import { EditorContextKeys } from '../../../../../src/ash/editor/common/editorContextKeys.js';
import type { LanguageDocumentSymbol } from '../../../../../src/ash/editor/common/languages.js';
import { TextModel } from '../../../../../src/ash/editor/common/model/textModel.js';
import { ILanguageFeaturesService } from '../../../../../src/ash/editor/common/services/languageFeatures.js';
import { OutlineModel } from '../documentSymbols/browser/outlineModel.js';

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

	public show(query = ''): void {
		const model = this.editor.getModel();
		if (!(model instanceof TextModel)) {
			this.dispose();
			return;
		}

		const picker = this._register(this.quickInput.createQuickPick<SymbolPick>());
		picker.ariaLabel = localize('gotoSymbol.dialog', 'Go to Symbol');
		picker.placeholder = localize('gotoSymbol.placeholder', 'Type a symbol name');
		picker.value = query;
		this._register(picker.onDidHide(() => this.dispose()));
		this._register(picker.onDidBlur(() => this.dispose()));
		this._register(picker.onDidChangeValue(value => {
			if (!value.startsWith('>') && !value.startsWith('?')) {
				return;
			}
			const commandAction = this.editor.getAction('editor.action.quickCommand');
			if (!commandAction?.isSupported()) {
				return;
			}
			picker.hide();
			void commandAction.run(value).catch(error => this.notifications.error(String(error)));
		}));
		this._register(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (!item) return;

			picker.hide();
			this.editor.setSelection(item.symbol.selectionRange, 'editor.action.quickOutline');
			this.editor.revealRange(item.symbol.selectionRange);

		}));

		const request = new AbortController();
		this._register(toDisposable(() => request.abort()));
		const close = () => this.dispose();
		this._register(this.editor.onDidChangeModelContent(close));
		this._register(this.editor.onDidChangeModel(close));
		this._register(this.editor.onDidChangeCursorSelection(close));
		this._register(this.editor.onDidDispose(close));
		this._register(model.onDidChangeLanguage(close));
		this._register(this.languageFeatures.documentSymbolProvider.onDidChange(close));
		picker.show();
		void OutlineModel.create(
			this.languageFeatures.documentSymbolProvider,
			model,
			request.signal,
			error => this.notifications.error(String(error)),
		).then(outline => {
			if (request.signal.aborted || !outline) {
				return;
			}
			picker.items = outline.asListOfDocumentSymbols().map(symbol => ({ symbol, label: symbol.name, description: symbol.detail }));
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

	public run(accessor: ServicesAccessor, editor: ICodeEditor, args?: unknown): void {
		accessor.get(IInstantiationService).createInstance(StandaloneGotoSymbolQuickAccessProvider, editor).show(typeof args === 'string' ? args : '');
	}
}

registerEditorAction(GotoSymbolAction);
