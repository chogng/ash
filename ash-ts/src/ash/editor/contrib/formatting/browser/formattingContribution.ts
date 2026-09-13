import type { IContextMenuProvider } from "../../../../base/browser/contextmenu.js";
import { ToolBar } from "../../../../base/browser/ui/toolbar/toolbar.js";
import type { IAction } from "../../../../base/common/actions.js";
import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { DocumentTextStyleAttributes, DocumentTextStyleFontFamily } from "../../../common/model/documentSchema.js";
import { addDisposableListener, h } from "../../../../base/browser/dom.js";

export type FormattingContext = "none" | "text" | "code";

export interface FormattingDocumentAction {
	readonly id: string;
	readonly label: string;
}

export interface FormattingState {
	readonly context: FormattingContext;
	readonly readOnly: boolean;
	readonly bold: boolean;
	readonly italic: boolean;
	readonly fontFamily: DocumentTextStyleFontFamily | undefined;
	readonly fontSize: number | undefined;
	readonly checkedDocumentActionIds: ReadonlySet<string>;
}

export interface FormattingContributionOptions {
	readonly documentActions: readonly FormattingDocumentAction[];
	readonly onToggleMark: (markType: "strong" | "em") => void;
	readonly onSetTextStyle: (attrs: DocumentTextStyleAttributes) => void;
	readonly onClearTextStyle: () => void;
	readonly onRunDocumentAction: (actionId: string) => void;
}

/**
 * Optional persistent document-formatting contribution.
 *
 * The contribution composes the shared ToolBar for runnable commands with
 * native selects for typography values. Its host supplies only formatting
 * state and document-command callbacks, keeping editor lifecycle independent
 * from this Word-like presentation surface.
 */
export class FormattingContribution extends Disposable {
	readonly element: HTMLDivElement;
	private readonly inlineActions: ToolBar;
	private readonly documentActions: ToolBar;
	private readonly typographyControls: HTMLDivElement;
	private readonly codeContext: HTMLDivElement;
	private readonly fontFamily: HTMLSelectElement;
	private readonly fontSize: HTMLSelectElement;

	constructor(container: HTMLElement, private readonly options: FormattingContributionOptions) {
		super();
		const ownerDocument = container.ownerDocument;
		const element = h(ownerDocument, "div");
		element.className = "stanza-structured-format-toolbar";
		element.hidden = true;
		element.setAttribute("role", "group");
		element.setAttribute("aria-label", "Document formatting");
		this.element = element;
		container.append(element);
		this._register(toDisposable(() => element.remove()));

		const inlineActions = this._register(new ToolBar(element, {
			contextMenuProvider: emptyFormattingContextMenuProvider,
			ariaLabel: "Text formatting",
			highlightToggledItems: true,
		}));
		inlineActions.element.classList.add("stanza-structured-format-inline-actions");
		this._register(addDisposableListener(inlineActions.element, 'mousedown', event => event.preventDefault()));
		this.inlineActions = inlineActions;

		const typographyControls = h(ownerDocument, "div");
		typographyControls.className = "stanza-structured-format-typography-controls";
		typographyControls.setAttribute("role", "group");
		typographyControls.setAttribute("aria-label", "Font and size");
		this.typographyControls = typographyControls;
		const fontFamily = createSelectControl(ownerDocument, "Font", "Font family", [
			{ value: "", label: "Default" },
			{ value: "sans", label: "Sans serif" },
			{ value: "serif", label: "Serif" },
			{ value: "monospace", label: "Monospace" },
		]);
		fontFamily.element.classList.add("stanza-structured-format-font-family");
		this._register(addDisposableListener(fontFamily.select, 'change', () => {
			const value = fontFamily.select.value;
			if (value === "") {
				options.onClearTextStyle();
				return;
			}
			options.onSetTextStyle({ fontFamily: value as DocumentTextStyleFontFamily });
		}));
		this.fontFamily = fontFamily.select;
		const fontSize = createSelectControl(ownerDocument, "Size", "Font size", [
			{ value: "", label: "Default" },
			...[10, 11, 12, 14, 16, 18, 20, 24, 28, 32].map(value => ({ value: String(value), label: `${value}` })),
		]);
		fontSize.element.classList.add("stanza-structured-format-font-size");
		this._register(addDisposableListener(fontSize.select, 'change', () => {
			const value = fontSize.select.value;
			if (value === "") {
				options.onClearTextStyle();
				return;
			}
			options.onSetTextStyle({ fontSize: Number(value) });
		}));
		this.fontSize = fontSize.select;
		typographyControls.append(fontFamily.element, fontSize.element);

		const documentActions = this._register(new ToolBar(element, {
			contextMenuProvider: emptyFormattingContextMenuProvider,
			ariaLabel: "Document structure",
			highlightToggledItems: true,
		}));
		documentActions.element.classList.add("stanza-structured-format-document-actions");
		this._register(addDisposableListener(documentActions.element, 'mousedown', event => event.preventDefault()));
		this.documentActions = documentActions;

		const codeContext = h(ownerDocument, "div");
		codeContext.className = "stanza-structured-format-code-context";
		codeContext.textContent = "Code block · Academic";
		codeContext.setAttribute("role", "status");
		this.codeContext = codeContext;

		element.append(inlineActions.element, typographyControls, documentActions.element, codeContext);
		this.setState({
			context: "none",
			readOnly: false,
			bold: false,
			italic: false,
			fontFamily: undefined,
			fontSize: undefined,
			checkedDocumentActionIds: new Set(),
		});
	}

	setState(state: FormattingState): void {
		const hasTextContext = state.context === "text";
		this.element.dataset.context = state.context;
		this.inlineActions.element.hidden = !hasTextContext;
		this.typographyControls.hidden = !hasTextContext;
		this.documentActions.element.hidden = !hasTextContext;
		this.codeContext.hidden = state.context !== "code";
		this.fontFamily.disabled = !hasTextContext || state.readOnly;
		this.fontSize.disabled = !hasTextContext || state.readOnly;
		setSelectValue(this.fontFamily, state.fontFamily ?? "");
		setSelectValue(this.fontSize, state.fontSize === undefined ? "" : String(state.fontSize));
		this.inlineActions.setActions([
			createAction("bold", "Bold", "Toggle bold", lxiconsLibrary.bold, hasTextContext && !state.readOnly, state.bold, () => this.options.onToggleMark("strong")),
			createAction("italic", "Italic", "Toggle italic", lxiconsLibrary.italics, hasTextContext && !state.readOnly, state.italic, () => this.options.onToggleMark("em")),
		]);
		this.documentActions.setActions(this.options.documentActions.map(action => createAction(
			action.id,
			action.label,
			action.label,
			undefined,
			hasTextContext && !state.readOnly,
			state.checkedDocumentActionIds.has(action.id),
			() => this.options.onRunDocumentAction(action.id),
		)));
	}
}

function createAction(id: string, label: string, tooltip: string, icon: IAction["icon"], enabled: boolean, checked: boolean, run: () => void): IAction {
	return { id, label, tooltip, icon, enabled, checked, run };
}

function createSelectControl(ownerDocument: Document, label: string, ariaLabel: string, options: readonly { readonly value: string; readonly label: string }[]): { readonly element: HTMLLabelElement; readonly select: HTMLSelectElement } {
	const element = h(ownerDocument, "label");
	element.className = "stanza-structured-format-select-control";
	const text = h(ownerDocument, "span");
	text.className = "stanza-structured-format-select-label";
	text.textContent = label;
	const select = h(ownerDocument, "select");
	select.className = "stanza-structured-format-select";
	select.setAttribute("aria-label", ariaLabel);
	for (const option of options) {
		const optionElement = h(ownerDocument, "option");
		optionElement.value = option.value;
		optionElement.textContent = option.label;
		select.append(optionElement);
	}
	element.append(text, select);
	return { element, select };
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
	select.value = value;
	if (select.value !== value) select.value = "";
}

const emptyFormattingContextMenuProvider: IContextMenuProvider = {
	showContextMenu(): never {
		throw new Error("Document formatting toolbars do not define secondary actions");
	},
};
