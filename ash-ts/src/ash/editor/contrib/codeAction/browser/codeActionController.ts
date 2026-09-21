import "./media/codeAction.css";
import { addDisposableListener, getActiveElement, stopEvent, h } from "../../../../base/browser/dom.js";
import { Disposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { Range } from "../../../common/core/range.js";
import * as languages from '../../../common/languages.js';
import { TextDecorationCollection } from "../../../common/model/decorationCollection.js";
import { type View } from "../../../browser/view.js";
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { EditorOption } from '../../../common/config/editorOptions.js';

interface CodeActionEntry {
	readonly action: languages.LanguageCodeAction;
	readonly original: languages.LanguageCodeAction;
	readonly provider: languages.LanguageCodeActionProvider;
}

/** Owns the editor-local code-action picker and routes selected edits through cursor commands. */
export class CodeActionController extends Disposable {
	private readonly element: HTMLDivElement;
	private readonly actionListeners = this._register(new DisposableStore());
	private request: AbortController | undefined;
	private context: languages.LanguageCodeActionRequest | undefined;
	private actions: readonly CodeActionEntry[] = [];
	private applying = false;

	constructor(
		private readonly input: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly diagnostics: TextDecorationCollection<languages.LanguageDiagnostic>,
		private readonly applyWorkspaceEdit: ((edit: languages.LanguageWorkspaceEdit) => void | Promise<void>) | undefined,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
	) {
		super();
		if (diagnostics.textModel !== viewport.textModel || editor.getModel() !== viewport.textModel) {
			throw new TypeError("Code action dependencies must share one text model");
		}
		const ownerDocument = viewport.domNode.domNode.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.className = "stanza-editor-code-action";
		this.element.hidden = true;
		this.element.setAttribute("role", "menu");
		viewport.domNode.domNode.append(this.element);
		this._register(toDisposable(() => {
			this.close();
			this.element.remove();
		}));
		this._register(addDisposableListener(this.element, 'pointerdown', event => event.stopPropagation()));
		this._register(addDisposableListener(this.element, 'mousedown', event => event.stopPropagation()));
		this._register(addDisposableListener(input, "keydown", event => {
			if (event.defaultPrevented || event.isComposing) return;
			if (event.key === "Escape" && this.request) {
				stopEvent(event);
				this.close();
				return;
			}
			if (event.altKey || (!event.ctrlKey && !event.metaKey) || event.key !== ".") return;
			stopEvent(event);
			void this.open();
		}));
		this._register(addDisposableListener(this.element, "keydown", event => {
			if (event.key !== "Escape") return;
			stopEvent(event);
			this.close();
		}));
		this._register(viewport.textModel.onDidChangeContent(() => this.close()));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.close()));
		this._register(viewport.textModel.onWillDispose(() => this.dispose()));
		this._register(editor.onDidChangeCursorSelection(() => this.close()));
		this._register(languageFeaturesService.codeActionProvider.onDidChange(() => this.close()));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.readOnly)) this.close();
		}));
	}

	private async open(): Promise<void> {
		this.close();
		const model = this.viewport.textModel;
		if (this.isDisposed || model.isDisposed() || this.editor.getOption(EditorOption.readOnly)) return;
		const range = this.editor.getSelection();
		if (!range) return;
		const controller = this.request = new AbortController();
		const context = this.context = {
			...languages.createLanguageFeatureRequest(model, model.getLanguageId(), controller.signal),
			resource: model.uri,
			range,
			diagnostics: this.diagnostics.decorations
				.filter(decoration => Range.areIntersectingOrTouching(decoration.range, range))
				.map(decoration => decoration.metadata),
		};
		try {
			const actions: CodeActionEntry[] = [];
			for (const provider of this.languageFeaturesService.codeActionProvider.ordered(model)) {
				if (!languages.isLanguageFeatureRequestCurrent(context)) return;
				try {
					const provided = await provider.provideCodeActions(context, controller.signal);
					if (!languages.isLanguageFeatureRequestCurrent(context)) return;
					actions.push(...provided.map(original => ({ action: normalizeLanguageCodeAction(original), original, provider })));
				} catch (error) {
					if (!languages.isLanguageFeatureRequestCurrent(context)) return;
					this.onError(error);
				}
			}
			if (!languages.isLanguageFeatureRequestCurrent(context)) return;
			if (actions.length === 0) {
				this.viewport.announceAccessibilityStatus("No code actions available.");
				this.close();
				return;
			}
			this.actions = actions;
			this.render();
		} catch (error) {
			if (languages.isLanguageFeatureRequestCurrent(context)) {
				this.close();
				this.onError(error);
			}
		}
	}

	private render(): void {
		this.actionListeners.clear();
		this.element.replaceChildren(...this.actions.map(({ action }, index) => {
			const button = h(this.element.ownerDocument, "button");
			button.type = "button";
			button.setAttribute("role", "menuitem");
			button.textContent = action.disabledReason ? `${action.title} (${action.disabledReason})` : action.title;
			button.disabled = action.disabledReason !== undefined;
			this.actionListeners.add(addDisposableListener(button, "click", () => void this.apply(index)));
			return button;
		}));
		const position = this.editor.getSelection()?.getStartPosition();
		if (!position) return;
		const coordinates = this.viewport.getPositionContentCoordinates(position);
		this.element.style.left = `${Math.max(8, coordinates.left - this.viewport.viewportLayout.scrollPosition.left)}px`;
		this.element.style.top = `${Math.max(8, coordinates.top - this.viewport.viewportLayout.scrollPosition.top + coordinates.height + 4)}px`;
		this.element.hidden = false;
		(this.element.querySelector("button:not(:disabled)") as HTMLButtonElement | null)?.focus({ preventScroll: true });
	}

	private async apply(index: number): Promise<void> {
		const entry = this.actions[index];
		const context = this.context;
		if (this.applying || !entry || !context || !languages.isLanguageFeatureRequestCurrent(context) || entry.action.disabledReason !== undefined) return;
		this.applying = true;
		this.element.setAttribute('aria-busy', 'true');
		let editDispatched = false;
		try {
			const resolved = !entry.action.edit && entry.provider.resolveCodeAction
				? normalizeLanguageCodeAction(await entry.provider.resolveCodeAction(entry.original, context, context.signal))
				: entry.action;
			if (!languages.isLanguageFeatureRequestCurrent(context)) return;
			if (resolved.disabledReason !== undefined) {
				this.viewport.announceAccessibilityStatus(resolved.disabledReason);
				this.close();
				return;
			}
			if (!resolved.edit) {
				this.viewport.announceAccessibilityStatus(`${resolved.title} has no text edit.`);
				this.close();
				return;
			}
			if (this.applyWorkspaceEdit) {
				editDispatched = true;
				await this.applyWorkspaceEdit(resolved.edit);
			} else {
				const documentEdit = resolved.edit.entries.find(edit => edit.kind === "textDocument" && edit.resource.toString() === context.resource.toString());
				if (resolved.edit.entries.length !== 1 || !documentEdit || documentEdit.kind !== "textDocument") throw new Error("This editor host cannot apply a multi-resource code action");
				if (documentEdit.version !== undefined && documentEdit.version !== context.snapshot.version) {
					throw new Error("Code action edit does not match the requested document version");
				}
				if (documentEdit.edits.length > 0) {
					editDispatched = true;
					this.editor.pushUndoStop();
					this.editor.executeEdits('editor.action.codeAction', [...documentEdit.edits]);
					this.editor.pushUndoStop();
				}
			}
			if (this.context === context) this.close();
		} catch (error) {
			if (editDispatched || languages.isLanguageFeatureRequestCurrent(context)) this.onError(error);
		} finally {
			if (this.context === context) {
				this.applying = false;
				this.element.removeAttribute('aria-busy');
			}
		}
	}

	private close(): void {
		const restoreFocus = this.element.contains(getActiveElement(this.element.ownerDocument));
		this.request?.abort();
		this.request = undefined;
		this.context = undefined;
		this.actions = [];
		this.applying = false;
		this.element.removeAttribute('aria-busy');
		this.element.hidden = true;
		this.actionListeners.clear();
		this.element.replaceChildren();
		if (!this.isDisposed && restoreFocus) this.input.focus({ preventScroll: true });
	}
}

function normalizeLanguageCodeAction(action: languages.LanguageCodeAction): languages.LanguageCodeAction {
	if (!action || typeof action !== "object" || typeof action.title !== "string" || action.title.trim().length === 0) {
		throw new TypeError("Code action title must be a non-empty string");
	}
	return Object.freeze({
		title: action.title,
		...(action.kind !== undefined ? { kind: action.kind } : {}),
		...(action.isPreferred !== undefined ? { isPreferred: action.isPreferred } : {}),
		...(action.disabledReason !== undefined ? { disabledReason: action.disabledReason } : {}),
		...(action.edit ? { edit: languages.normalizeLanguageWorkspaceEdit(action.edit) } : {}),
		...(action.data !== undefined ? { data: action.data } : {}),
	});
}
