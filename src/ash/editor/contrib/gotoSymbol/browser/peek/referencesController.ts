import { ISymbolNavigationService } from '../symbolNavigation.js';
import { ReferenceWidget } from './referencesWidget.js';
import { localize } from '../../../../../nls.js';
import { registerEditorContribution } from '../../../../browser/editorExtensions.js';
import { getDefinitionsAtPosition, getDeclarationsAtPosition, getImplementationsAtPosition, getTypeDefinitionsAtPosition, getReferencesAtPosition } from '../goToSymbol.js';
import { ReferencesModel } from '../referencesModel.js';
import { addDisposableListener, stopEvent } from '../../../../../base/browser/dom.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { type URI } from '../../../../../base/common/uri.js';
import { Selection } from '../../../../common/core/selection.js';
import { type Position } from '../../../../common/core/position.js';
import { type View } from '../../../../browser/view.js';
import { type ICodeEditor } from '../../../../browser/editorBrowser.js';
import { ILanguageFeaturesService } from '../../../../common/services/languageFeatures.js';
import { Range } from '../../../../common/core/range.js';
import { ICodeEditorService } from '../../../../browser/services/codeEditorService.js';
import { extUri } from '../../../../../base/common/resources.js';
import { type LanguageLocation } from '../../../../common/languages.js';

export type SymbolNavigationKind = 'definition' | 'declaration' | 'implementation' | 'typeDefinition' | 'references';

/** Owns keyboard navigation and the multi-result Peek surface for one text editor. */
export class ReferencesController extends Disposable {
	public static readonly ID = 'editor.contrib.referencesController';
	public static get(editor: ICodeEditor): ReferencesController | null { return editor.getContribution<ReferencesController>(ReferencesController.ID); }
	private readonly peek = this._register(new DisposableStore());
	private request: AbortController | undefined;

	constructor(
		private readonly input: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly resource: URI,
		private readonly openLocation: ((location: LanguageLocation) => void | Promise<void>) | undefined,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly languageFeatures: ILanguageFeaturesService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ISymbolNavigationService private readonly symbolNavigation: ISymbolNavigationService,
		@ICodeEditorService private readonly codeEditors: ICodeEditorService,
	) {
		super();
		if (viewport.textModel !== editor.getModel()) { throw new TypeError('Language navigation dependencies must share one text model'); }
		this._register(addDisposableListener(input, 'keydown', event => this.handleKeydown(event)));
		this._register(viewport.textModel.onDidChangeContent(() => this.closePeek()));
		this._register(toDisposable(() => this.closePeek()));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.closePeek()));
		this._register(viewport.textModel.onWillDispose(() => this.closePeek()));
		this._register(editor.onDidChangeCursorSelection(() => this.closePeek()));
		this._register(editor.onDidBlurEditorWidget(() => this.closePeek()));
		for (const registry of [languageFeatures.definitionProvider, languageFeatures.declarationProvider,
		languageFeatures.implementationProvider, languageFeatures.typeDefinitionProvider, languageFeatures.referenceProvider]) {
			this._register(registry.onDidChange(() => this.closePeek()));
		}
	}

	public navigate(kind: SymbolNavigationKind, options: { readonly peek?: boolean; readonly includeDeclaration?: boolean; readonly openToSide?: boolean; } = {}): Promise<void> {
		return this.requestLocations(kind, options);
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState('AltGraph') || event.key !== 'F12') { return; }
		let command: string;
		if (event.shiftKey && (event.ctrlKey || event.metaKey)) {
			command = 'editor.action.peekImplementation';
		} else if (event.ctrlKey || event.metaKey) {
			command = 'editor.action.goToImplementation';
		} else if (event.shiftKey) {
			command = 'editor.action.goToReferences';
		} else {
			command = event.altKey ? 'editor.action.peekDefinition' : this.editor.getAction('editor.gotoNextSymbolFromResult')?.isSupported() ? 'editor.gotoNextSymbolFromResult' : 'editor.action.revealDefinition';
		}
		const action = this.editor.getAction(command);
		if (!action?.isSupported()) { return; }
		stopEvent(event);
		void action.run().catch(this.onError);
	}

	private async requestLocations(kind: SymbolNavigationKind, options: { readonly peek?: boolean; readonly includeDeclaration?: boolean; readonly openToSide?: boolean; } = {}): Promise<void> {
		this.closePeek();
		const request = this.request = new AbortController();
		const position = this.editor.getSelections()![0]!.getPosition();
		try {
			const model = this.viewport.textModel;
			let links;
			switch (kind) {
				case 'definition': links = await getDefinitionsAtPosition(this.languageFeatures.definitionProvider, model, position, false, request.signal, this.onError); break;
				case 'declaration': links = await getDeclarationsAtPosition(this.languageFeatures.declarationProvider, model, position, false, request.signal, this.onError); break;
				case 'implementation': links = await getImplementationsAtPosition(this.languageFeatures.implementationProvider, model, position, false, request.signal, this.onError); break;
				case 'typeDefinition': links = await getTypeDefinitionsAtPosition(this.languageFeatures.typeDefinitionProvider, model, position, false, request.signal, this.onError); break;
				case 'references': links = await getReferencesAtPosition(this.languageFeatures.referenceProvider, model, position, !(options.includeDeclaration ?? true), false, request.signal, this.onError); break;
			}
			using results = new ReferencesModel(links, navigationLabel(kind));
			const locations = results.references.map(reference => Object.freeze({ resource: reference.uri, range: Range.lift(reference.link.range), ...(reference.link.targetSelectionRange ? { selectionRange: Range.lift(reference.link.targetSelectionRange) } : {}) }));
			if (request.signal.aborted) { return; }
			if (locations.length === 0) {
				this.viewport.announceAccessibilityStatus(localize('references.noResults', 'No {0} found.', navigationLabel(kind)));
				return;
			}
			if (options.peek || locations.length > 1) {
				this.showPeek(position, results, options.openToSide);
				return;
			}
			await this.open(locations[0]!, options.openToSide);
		} catch (error) {
			if (!request.signal.aborted) { this.onError(error); }
		}
	}

	private showPeek(anchor: Position, results: ReferencesModel, openToSide = false): void {
		this.peek.clear();
		const model = this.peek.add(results.clone());
		const widget = this.peek.add(this.instantiationService.createInstance(ReferenceWidget, this.editor, this.onError));
		this.peek.add(widget.onDidClose(() => this.closePeek()));
		this.peek.add(widget.onDidSelectReference(reference => {
			this.symbolNavigation.put(reference);
			void this.open(Object.freeze({ resource: reference.uri, range: Range.lift(reference.link.range), selectionRange: Range.lift(reference.range) }), openToSide).catch(this.onError);
		}));
		widget.show(anchor);
		// View zones mount during rendering; keyboard focus must follow their attachment.
		this.viewport.render(true, false);
		void widget.setModel(model).then(() => {
			if (!widget.isDisposed) { widget.focusOnReferenceTree(); }
		}).catch(this.onError);
		this.viewport.announceAccessibilityStatus(model.ariaMessage);
	}
	private async open(location: LanguageLocation, openToSide = false): Promise<void> {
		this.closePeek();
		const range = location.selectionRange ?? location.range;
		if (openToSide) {
			await this.codeEditors.openCodeEditor({ resource: location.resource, options: { selection: range } }, this.editor, true);
			return;
		}
		if (extUri.isEqual(location.resource, this.resource)) {
			this.editor.setSelections([
				Selection.fromPositions(range.getStartPosition(), range.getEndPosition()),
			], 'editor.action.goToLocation');
			this.viewport.revealPosition(range.getStartPosition());
			this.input.focus({ preventScroll: true });
			return;
		}
		if (!this.openLocation) {
			this.viewport.announceAccessibilityStatus(localize('references.cannotOpen', 'This editor host cannot open the target resource.'));
			return;
		}
		await this.openLocation(location);
	}

	private closePeek(): void {
		this.cancelRequest();
		this.peek.clear();
	}

	private cancelRequest(): void {
		this.request?.abort();
		this.request = undefined;
	}
}

function navigationLabel(kind: SymbolNavigationKind): string {
	switch (kind) {
		case 'definition': return localize('references.definition', 'Definition');
		case 'declaration': return localize('references.declaration', 'Declaration');
		case 'implementation': return localize('references.implementation', 'Implementation');
		case 'typeDefinition': return localize('references.typeDefinition', 'Type Definition');
		case 'references': return localize('references.references', 'References');
	}
}


registerEditorContribution({
	id: ReferencesController.ID, install: context => {
		if (context.kind !== 'text') { return; }
		return context.instantiationService.createInstance(ReferencesController,
			context.controller.element, context.editor, context.view, context.model.uri,
			context.options.onOpenLocation, context.onLanguageError,
		);
	}
});
