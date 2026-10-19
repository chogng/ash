import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../../../src/ash/base/common/lifecycle.js';
import { KeyCode } from '../../../../../../src/ash/base/common/keyCodes.js';
import { extUri } from '../../../../../../src/ash/base/common/resources.js';
import { localize2 } from '../../../../../../src/ash/nls.js';
import { createDecorator, IInstantiationService } from '../../../../../../src/ash/platform/instantiation/common/instantiation.js';
import { IContextKeyService } from '../../../../../../src/ash/platform/contextkey/browser/contextKeyService.js';
import { RawContextKey, type IContextKey, ContextKeyExpr } from '../../../../../../src/ash/platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../../../src/ash/platform/keybinding/common/keybindingsRegistry.js';
import { ICodeEditorService } from '../../../../../../src/ash/editor/browser/services/codeEditorService.js';
import { type ICodeEditor } from '../../../../../../src/ash/editor/browser/editorBrowser.js';
import { EditorAction, registerEditorAction, registerEditorContribution, type ServicesAccessor } from '../../../registration.js';
import { EditorContextKeys } from '../../../../../../src/ash/editor/common/editorContextKeys.js';
import { type OneReference } from './referencesModel.js';
import { Position } from '../../../../../../src/ash/editor/common/core/position.js';
import { EmbeddedCodeEditorWidget } from '../../../../../../src/ash/editor/browser/widget/codeEditor/embeddedCodeEditorWidget.js';

export const ctxHasSymbols = new RawContextKey<boolean>('hasSymbols', false);
export const ISymbolNavigationService = createDecorator<ISymbolNavigationService>('ISymbolNavigationService');

export interface ISymbolNavigationService extends IDisposable {
	readonly _serviceBrand: undefined;
	attachEditor(editor: ICodeEditor): IDisposable;
	reset(): void;
	put(anchor: OneReference): void;
	revealNext(source: ICodeEditor): Promise<void>;
}

class SymbolNavigationService extends Disposable implements ISymbolNavigationService {
	public declare readonly _serviceBrand: undefined;
	private readonly session = this._register(new DisposableStore());
	private readonly contexts = new Set<IContextKey<boolean>>();
	private anchor: OneReference | undefined;

	constructor(@ICodeEditorService private readonly editors: ICodeEditorService) {
		super();
		this._register(toDisposable(() => this.reset()));
	}
	public attachEditor(editor: ICodeEditor): IDisposable {
		const key = editor.invokeWithinContext(accessor => ctxHasSymbols.bindTo(accessor.get(IContextKeyService)));
		this.contexts.add(key);
		key.set(this.anchor !== undefined);
		return toDisposable(() => { this.contexts.delete(key); key.reset(); });
	}

	public reset(): void {
		this.anchor = undefined;
		for (const key of this.contexts) key.reset();
		this.session.clear();
	}
	public put(anchor: OneReference): void {
		this.reset();
		if (anchor.parent.parent.references.length < 2) { return; }
		const model = this.session.add(anchor.parent.parent.clone());
		this.anchor = model.referenceAt(anchor.uri, new Position(anchor.range.startLineNumber, anchor.range.startColumn));
		for (const key of this.contexts) key.set(true);
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

// Navigation spans editors in one window. Its last provider/view lease releases the shared session.
const navigationScopes = new WeakMap<ICodeEditorService, { readonly service: SymbolNavigationService; users: number; }>();
const symbolNavigationId = 'editor.contrib.symbolNavigation';
class SymbolNavigationContribution extends Disposable {
	constructor(readonly service: ISymbolNavigationService, editor: ICodeEditor) {
		super();
		this._register(service.attachEditor(editor));
	}
}
registerEditorContribution({
	id: symbolNavigationId,
	configure: context => {
		const editors = context.getService(ICodeEditorService);
		let entry = navigationScopes.get(editors);
		if (!entry) {
			entry = { service: context.getService(IInstantiationService).createInstance(SymbolNavigationService), users: 0 };
			navigationScopes.set(editors, entry);
		}
		entry.users++;
		const lease = entry;
		context.register(toDisposable(() => {
			if (--lease.users === 0) { navigationScopes.delete(editors); lease.service.dispose(); }
		}));
		context.provideService(ISymbolNavigationService, lease.service);
	},
	install: context => new SymbolNavigationContribution(context.getService(ISymbolNavigationService), context.editor),
});

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
		await editor.getContribution<SymbolNavigationContribution>(symbolNavigationId)?.service.revealNext(editor);
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
	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void { editor.getContribution<SymbolNavigationContribution>(symbolNavigationId)?.service.reset(); }
}
registerEditorAction(CancelSymbolNavigation);
