import { localize, localize2 } from '../../../../nls.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { type ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorAction, registerEditorAction, registerEditorContribution, type ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { addDisposableListener, stopEvent } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { type View } from '../../../../editor/browser/view.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { type LanguageHierarchyItem, type LanguageLocation } from '../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { TypeHierarchyModel } from '../common/typeHierarchy.js';
import { TypeHierarchyTreePeekWidget } from './typeHierarchyPeek.js';

class PeekTypeHierarchyAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.showTypeHierarchy',
			label: localize2('typeHierarchy.peek', 'Peek Type Hierarchy'),
			precondition: EditorContextKeys.hasTypeHierarchyProvider.isEqualTo(true),
			contextMenuOpts: { menuId: MenuId.EditorContextPeek, group: 'navigation', order: 1000 },
		});
	}

	async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		editor.focus();
		await TypeHierarchyController.get(editor)?.startTypeHierarchyFromEditor();
	}
}

registerEditorAction(PeekTypeHierarchyAction);

class TypeHierarchyController extends Disposable {
	static readonly Id = 'typeHierarchy';
	static get(editor: ICodeEditor): TypeHierarchyController | null {
		return editor.getContribution<TypeHierarchyController>(TypeHierarchyController.Id);
	}
	private readonly peek = this._register(new DisposableStore());
	private request: AbortController | undefined;

	constructor(
		input: HTMLElement, private readonly editor: ICodeEditor, private readonly view: View,
		private readonly openLocation: ((location: LanguageLocation) => void | Promise<void>) | undefined,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly features: ILanguageFeaturesService,
	) {
		super();
		this._register(toDisposable(() => this.close()));
		this._register(addDisposableListener(input, 'keydown', event => {
			if (event.defaultPrevented || event.isComposing || event.getModifierState('AltGraph')) { return; }
			if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 't') {
				if (!editor.getAction('editor.showTypeHierarchy')?.isSupported()) { return; }
				stopEvent(event);
				editor.trigger('keyboard', 'editor.showTypeHierarchy', {});
			}
		}));
		this._register(view.textModel.onDidChangeContent(() => this.close()));
		this._register(view.textModel.onDidChangeLanguage(() => this.close()));
		this._register(view.textModel.onWillDispose(() => this.close()));
		this._register(editor.onDidChangeCursorSelection(() => this.close()));
		this._register(editor.onDidBlurEditorWidget(() => this.close()));
		this._register(features.typeHierarchyProvider.onDidChange(() => this.close()));
	}

	async startTypeHierarchyFromEditor(): Promise<void> {
		this.close();
		const anchor = this.editor.getPosition();
		if (!anchor || this.isDisposed) { return; }
		const request = this.request = new AbortController();
		try {
			const model = await TypeHierarchyModel.create(this.view.textModel, anchor, request.signal, this.features.typeHierarchyProvider, this.onError);
			if (request.signal.aborted) { model?.dispose(); return; }
			if (!model) {
				this.view.announceAccessibilityStatus(localize('typeHierarchy.empty', 'No type hierarchy found.'));
				return;
			}
			this.peek.add(model);
			const widget = this.peek.add(new TypeHierarchyTreePeekWidget(this.editor, this.onError));
			this.peek.add(widget.onDidClose(() => this.close()));
			this.peek.add(widget.onDidSelectItem(item => { void this.open(item).catch(this.onError); }));
			widget.show(anchor);
			// The View must attach the zone before a result can take focus.
			this.view.render(true, false);
			await widget.showModel(model);
			if (!request.signal.aborted) {
				widget.element.querySelector<HTMLButtonElement>('.stanza-editor-language-hierarchy-item')?.focus({ preventScroll: true });
			}
		} catch (error) {
			if (!request.signal.aborted) { this.onError(error); this.close(); }
		}
	}

	private async open(item: LanguageHierarchyItem): Promise<void> {
		const location = { resource: item.resource, range: item.range, selectionRange: item.selectionRange };
		if (item.resource.toString() === this.view.textModel.uri.toString()) {
			this.editor.setSelection(Selection.fromPositions(item.selectionRange.getStartPosition(), item.selectionRange.getEndPosition()), 'editor.showTypeHierarchy');
			this.editor.revealPosition(item.selectionRange.getStartPosition());
			this.editor.focus();
		} else {
			await this.openLocation?.(location);
		}
	}

	private close(): void {
		this.request?.abort();
		this.request = undefined;
		this.peek.clear();
	}
}

registerEditorContribution({
	id: TypeHierarchyController.Id,
	install: context => {
		if (context.kind !== 'text') { return; }
		return context.instantiationService.createInstance(TypeHierarchyController,
			context.controller.element, context.editor, context.view, context.options.onOpenLocation, context.onLanguageError);
	},
});
