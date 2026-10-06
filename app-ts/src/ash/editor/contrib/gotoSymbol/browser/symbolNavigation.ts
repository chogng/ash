import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { extUri } from '../../../../base/common/resources.js';
import { localize2 } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey, type IContextKey, ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { ICodeEditorService } from '../../../browser/services/codeEditorService.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { type OneReference } from './referencesModel.js';
import { Position } from '../../../common/core/position.js';
import { EmbeddedCodeEditorWidget } from '../../../browser/widget/codeEditor/embeddedCodeEditorWidget.js';

export const ctxHasSymbols = new RawContextKey<boolean>('hasSymbols', false);
export const ISymbolNavigationService = createDecorator<ISymbolNavigationService>('ISymbolNavigationService');

export interface ISymbolNavigationService {
	readonly _serviceBrand: undefined;
	reset(): void;
	put(anchor: OneReference): void;
	revealNext(source: ICodeEditor): Promise<void>;
}

class SymbolNavigationService extends Disposable implements ISymbolNavigationService {
	public declare readonly _serviceBrand: undefined;
	private readonly session = this._register(new DisposableStore());
	private readonly hasSymbols: IContextKey<boolean>;
	private anchor: OneReference | undefined;

	constructor(@IContextKeyService contextKeys: IContextKeyService, @ICodeEditorService private readonly editors: ICodeEditorService) {
		super();
		this.hasSymbols = ctxHasSymbols.bindTo(contextKeys);
		this._register(toDisposable(() => this.reset()));
	}
	public reset(): void {
		this.anchor = undefined;
		this.hasSymbols.reset();
		this.session.clear();
	}
	public put(anchor: OneReference): void {
		this.reset();
		if (anchor.parent.parent.references.length < 2) { return; }
		const model = this.session.add(anchor.parent.parent.clone());
		this.anchor = model.referenceAt(anchor.uri, new Position(anchor.range.startLineNumber, anchor.range.startColumn));
		this.hasSymbols.set(true);
		for (const editor of this.editors.listCodeEditors()) {
			if (editor instanceof EmbeddedCodeEditorWidget) { continue; }
			const textModel = editor.getModel();
			if (!textModel || !model.groups.some(group => extUri.isEqual(group.uri, textModel.uri))) { continue; }
			this.session.add(textModel.onDidChangeContent(() => this.reset()));
			this.session.add(textModel.onWillDispose(() => this.reset()));
			this.session.add(editor.onDidChangeCursorSelection(event => {
				if (!model.referenceAt(textModel.uri, event.selection.getPosition())) { this.reset(); }
			}));
			this.session.add(editor.onDidChangeModel(() => this.reset()));
		}
	}
	public async revealNext(source: ICodeEditor): Promise<void> {
		const anchor = this.anchor;
		if (!anchor) { return; }
		const next = anchor.parent.parent.nextOrPreviousReference(anchor, true);
		this.anchor = next;
		if (source.getModel() && extUri.isEqual(source.getModel()!.uri, next.uri)) {
			source.setSelection(next.range);
			source.revealRange(next.range);
			source.focus();
			return;
		}
		await this.editors.openCodeEditor({ resource: next.uri, options: { selection: next.range } }, source);
	}
}

registerSingleton(ISymbolNavigationService, SymbolNavigationService, InstantiationType.Delayed);

class GoToNextSymbol extends EditorAction {
	constructor() {
		super({
			id: 'editor.gotoNextSymbolFromResult',
			label: localize2('references.nextResult', 'Go to Next Symbol Result'),
			precondition: ctxHasSymbols.isEqualTo(true),
			kbOpts: { primary: KeyCode.F12, kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true), weight: KeybindingWeight.EditorContrib + 50 },
		});
	}
	public async run(accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		await accessor.get(ISymbolNavigationService).revealNext(editor);
	}
}
registerEditorAction(GoToNextSymbol);

class CancelSymbolNavigation extends EditorAction {
	constructor() {
		super({
			id: 'editor.cancelSymbolNavigation',
			label: localize2('references.cancelNavigation', 'Cancel Symbol Navigation'),
			precondition: ctxHasSymbols.isEqualTo(true),
			kbOpts: { primary: KeyCode.Escape, kbExpr: ContextKeyExpr.and(ctxHasSymbols.isEqualTo(true), EditorContextKeys.editorTextFocus.isEqualTo(true)), weight: KeybindingWeight.EditorContrib + 50 },
		});
	}
	public run(accessor: ServicesAccessor): void { accessor.get(ISymbolNavigationService).reset(); }
}
registerEditorAction(CancelSymbolNavigation);
