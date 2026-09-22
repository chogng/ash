import { addDisposableListener, stopEvent, h } from "../../../../base/browser/dom.js";
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EmbeddedCodeEditorWidget } from '../../../browser/widget/codeEditor/embeddedCodeEditorWidget.js';
import { Disposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { Selection } from "../../../common/core/selection.js";
import { type Position } from "../../../common/core/position.js";
import { type View } from "../../../browser/view.js";
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { PeekViewWidget } from "../../peekView/browser/peekView.js";
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { type LanguageFeatureRegistry } from '../../../common/languageFeatureRegistry.js';
import { createLanguageFeatureRequest, isLanguageFeatureRequestCurrent, type LanguageLocationRequest } from '../../../common/languages.js';
import { Range } from '../../../common/core/range.js';
import { type LanguageLocation } from "../../../common/languages.js";

export type LanguageNavigationKind = "definition" | "declaration" | "implementation" | "typeDefinition" | "references";

/** Owns keyboard navigation and the multi-result Peek surface for one text editor. */
export class LanguageNavigationController extends Disposable {
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
	) {
		super();
		if (viewport.textModel !== editor.getModel()) throw new TypeError("Language navigation dependencies must share one text model");
		this._register(addDisposableListener(input, "keydown", event => this.handleKeydown(event)));
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

	navigate(kind: LanguageNavigationKind, options: { readonly peek?: boolean; readonly includeDeclaration?: boolean } = {}): Promise<void> {
		return this.requestLocations(kind, options);
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState("AltGraph") || event.key !== "F12") return;
		stopEvent(event);
		if (event.shiftKey && (event.ctrlKey || event.metaKey)) {
			void this.requestLocations("typeDefinition");
		} else if (event.ctrlKey || event.metaKey) {
			void this.requestLocations("implementation");
		} else if (event.shiftKey) {
			void this.requestLocations("references", { peek: true, includeDeclaration: true });
		} else {
			void this.requestLocations("definition", { peek: event.altKey });
		}
	}

	private async requestLocations(kind: LanguageNavigationKind, options: { readonly peek?: boolean; readonly includeDeclaration?: boolean } = {}): Promise<void> {
		this.closePeek();
		const request = this.request = new AbortController();
		const position = this.editor.getSelections()![0]!.getPosition();
		try {
			const locations = await this.provide(kind, position, options.includeDeclaration ?? true, request.signal);
			if (request.signal.aborted) return;
			if (locations.length === 0) {
				this.viewport.announceAccessibilityStatus(`No ${navigationLabel(kind)} found.`);
				return;
			}
			if (options.peek || locations.length > 1) {
				this.showPeek(kind, position, locations);
				return;
			}
			await this.open(locations[0]!);
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		}
	}

	private provide(kind: LanguageNavigationKind, position: Position, includeDeclaration: boolean, signal: AbortSignal): Promise<readonly LanguageLocation[]> {
		const model = this.viewport.textModel;
		const request = { ...createLanguageFeatureRequest(model, model.getLanguageId(), signal), resource: this.resource, position };
		switch (kind) {
			case 'definition': return this.collect(request, this.languageFeatures.definitionProvider, provider => provider.provideDefinition(request, signal));
			case 'declaration': return this.collect(request, this.languageFeatures.declarationProvider, provider => provider.provideDeclaration(request, signal));
			case 'implementation': return this.collect(request, this.languageFeatures.implementationProvider, provider => provider.provideImplementation(request, signal));
			case 'typeDefinition': return this.collect(request, this.languageFeatures.typeDefinitionProvider, provider => provider.provideTypeDefinition(request, signal));
			case 'references': return this.collect(request, this.languageFeatures.referenceProvider, provider => provider.provideReferences({ ...request, includeDeclaration }, signal));
		}
	}

	private async collect<T>(request: LanguageLocationRequest, registry: LanguageFeatureRegistry<T>, provide: (provider: T) => readonly LanguageLocation[] | Promise<readonly LanguageLocation[]>): Promise<readonly LanguageLocation[]> {
		const locations: LanguageLocation[] = [];
		for (const provider of registry.ordered(request.model)) {
			if (!isLanguageFeatureRequestCurrent(request)) {
				return [];
			}
			try {
				const values = await provide(provider);
				if (!isLanguageFeatureRequestCurrent(request)) {
					return [];
				}
				locations.push(...values.map(normalizeLanguageLocation));
			} catch (error) {
				if (!request.signal.aborted) {
					this.onError(error);
				}
			}
		}
		return deduplicateLocations(locations);
	}

	private showPeek(kind: LanguageNavigationKind, anchor: Position, locations: readonly LanguageLocation[]): void {
		this.peek.clear();
		const widget = this.peek.add(new PeekViewWidget(this.editor));
		widget.setTitle(`${locations.length} ${navigationLabel(kind)}${locations.length === 1 ? "" : "s"}`);
		this.peek.add(widget.onDidClose(() => this.closePeek()));
		const list = h(widget.element.ownerDocument, "div");
		list.className = "stanza-editor-language-locations";
		list.setAttribute("role", "listbox");
		for (const location of locations) {
			const button = h(widget.element.ownerDocument, "button");
			button.type = "button";
			button.setAttribute("role", "option");
			button.className = "stanza-editor-language-location";
			const selection = location.selectionRange ?? location.range;
			button.textContent = `${resourceLabel(location.resource)}:${selection.startLineNumber}:${selection.startColumn}`;
			this.peek.add(addDisposableListener(button, "click", () => void this.open(location)));
			list.append(button);
		}
		const body = h(widget.element.ownerDocument, 'div');
		body.append(list);
		const sameResource = locations.find(location => location.resource.toString() === this.resource.toString());
		const model = this.editor.getModel();
		if (sameResource && model) {
			const previewHost = h(widget.element.ownerDocument, 'div');
			previewHost.className = 'stanza-editor-language-preview';
			body.append(previewHost);
			const preview = this.peek.add(this.instantiationService.createInstance(EmbeddedCodeEditorWidget,
				previewHost,
				{ readOnly: true, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false },
				{ container: previewHost, model, input: { resource: model.uri, readOnly: true }, languageId: model.getLanguageId(), presentation: 'embedded', ariaLabel: 'Reference preview' },
				this.editor,
			));
			const range = sameResource.selectionRange ?? sameResource.range;
			preview.setSelection(range);
			preview.revealRange(range);
		}
		widget.setBody(body);
		widget.show(anchor);
		(list.firstElementChild as HTMLButtonElement | null)?.focus({ preventScroll: true });

		this.viewport.announceAccessibilityStatus(`${locations.length} ${navigationLabel(kind)}${locations.length === 1 ? "" : "s"} found.`);
	}

	private async open(location: LanguageLocation): Promise<void> {
		this.closePeek();
		const range = location.selectionRange ?? location.range;
		if (location.resource.toString() === this.resource.toString()) {
			this.editor.setSelections([
				Selection.fromPositions(range.getStartPosition(), range.getEndPosition()),
			], 'editor.action.goToLocation');
			this.viewport.revealPosition(range.getStartPosition());
			this.input.focus({ preventScroll: true });
			return;
		}
		if (!this.openLocation) {
			this.viewport.announceAccessibilityStatus("This editor host cannot open the target resource.");
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

function navigationLabel(kind: LanguageNavigationKind): string {
	switch (kind) {
		case "typeDefinition": return "type definition";
		default: return kind;
	}
}

function resourceLabel(resource: URI): string {
	const path = decodeURIComponent(resource.path).replace(/\/+$/, "");
	return path.slice(path.lastIndexOf("/") + 1) || resource.toString();
}

function normalizeLanguageLocation(location: LanguageLocation): LanguageLocation {
	if (!location || typeof location !== "object" || !location.resource || !(location.range instanceof Object)) throw new TypeError("Language location requires a resource and range");
	const range = Range.fromPositions(location.range.getStartPosition(), location.range.getEndPosition());
	const selectionRange = location.selectionRange ? Range.fromPositions(location.selectionRange.getStartPosition(), location.selectionRange.getEndPosition()) : undefined;
	if (selectionRange && !range.containsRange(selectionRange)) throw new RangeError("Language location selection must be contained by its target range");
	return Object.freeze({ resource: location.resource, range, ...(selectionRange ? { selectionRange } : {}) });
}

function deduplicateLocations(locations: readonly LanguageLocation[]): readonly LanguageLocation[] {
	const keys = new Set<string>();
	const result: LanguageLocation[] = [];
	for (const location of locations) {
		const selection = location.selectionRange ?? location.range;
		const key = `${location.resource.toString()}\u0000${location.range.getStartPosition().lineNumber}:${location.range.getStartPosition().column}:${location.range.getEndPosition().lineNumber}:${location.range.getEndPosition().column}:${selection.getStartPosition().lineNumber}:${selection.getStartPosition().column}:${selection.getEndPosition().lineNumber}:${selection.getEndPosition().column}`;
		if (keys.has(key)) continue;
		keys.add(key);
		result.push(location);
	}
	return Object.freeze(result);
}
