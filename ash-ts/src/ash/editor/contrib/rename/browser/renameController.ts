import "./renameWidget.css";
import { registerEditorContribution } from "../../../browser/editorExtensions.js";
import { addDisposableListener, stopEvent, h } from "../../../../base/browser/dom.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { type View } from "../../../browser/view.js";
import { RenameService } from "../common/languageRename.js";
import { type LanguageWorkspaceEdit } from "../../../common/languages/languageWorkspaceEdit.js";
import { type EditorCommandExecutor } from '../../../browser/editorExtensions.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { type IIdentifiedSingleEditOperation } from '../../../common/model.js';

export const RenameCommandId = 'editor.action.rename';

interface RenameEditor extends Pick<ICodeEditor, 'getModel' | 'getSelections'> {
	pushUndoStop(): boolean;
	executeEdits(source: string | null | undefined, edits: IIdentifiedSingleEditOperation[]): boolean;
}

/** Owns the local rename input and applies provider edits through the editor edit contract. */
export class RenameController extends Disposable {
	private readonly element: HTMLDivElement;
	private readonly input: HTMLInputElement;
	private readonly status: HTMLSpanElement;
	private request: AbortController | undefined;

	constructor(
		private readonly editorInput: HTMLElement,
		private readonly editor: RenameEditor,
		private readonly viewport: View,
		private readonly service: RenameService,
		private readonly languageId: string,
		private readonly resource: URI,
		private readonly applyWorkspaceEdit: ((edit: LanguageWorkspaceEdit) => void | Promise<void>) | undefined,
		private readonly onError: (error: unknown) => void = error => console.error("Editor rename failed", error),
		private readonly executeCommand: EditorCommandExecutor = (_commandId, operation) => operation(),
	) {
		super();
		if (viewport.textModel !== editor.getModel()) throw new TypeError("Stanza rename dependencies must share one text model");
		const ownerDocument = viewport.domNode.domNode.ownerDocument;
		this.element = h(ownerDocument, "div");
		this.element.className = "stanza-editor-rename";
		this.element.hidden = true;
		this.input = h(ownerDocument, "input");
		this.input.className = "stanza-editor-rename-input";
		this.input.type = "text";
		this.input.setAttribute("aria-label", "New symbol name");
		this.status = h(ownerDocument, "span");
		this.status.className = "stanza-editor-rename-status";
		this.status.setAttribute("aria-live", "polite");
		this.element.append(this.input, this.status);
		viewport.domNode.domNode.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this._register(addDisposableListener(editorInput, "keydown", event => {
			if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.key !== "F2") return;
			stopEvent(event);
			void this.open();
		}));
		this._register(addDisposableListener(this.element, "keydown", event => this.handleWidgetKeydown(event)));
	}

	private async open(): Promise<void> {
		this.cancelRequest();
		const request = this.request = new AbortController();
		try {
			const active = this.editor.getSelections()![0]!.getPosition();
			const preparation = await this.service.prepareRename(this.languageId, active, request.signal);
			if (request.signal.aborted) return;
			if (!preparation) {
				this.viewport.announceAccessibilityStatus("Rename is not available at this position.");
				return;
			}
			this.element.hidden = false;
			this.status.textContent = preparation.placeholder;
			this.input.value = preparation.placeholder;
			const coordinates = this.viewport.getPositionContentCoordinates(preparation.range.getStartPosition());
			this.element.style.left = `${Math.max(8, coordinates.left - this.viewport.viewportLayout.scrollPosition.left)}px`;
			this.element.style.top = `${Math.max(8, coordinates.top - this.viewport.viewportLayout.scrollPosition.top + coordinates.height + 4)}px`;
			this.input.focus({ preventScroll: true });
			this.input.select();
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		}
	}

	private handleWidgetKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing) return;
		if (event.key === "Escape") {
			stopEvent(event);
			this.close();
			return;
		}
		if (event.key !== "Enter" || event.ctrlKey || event.metaKey || event.altKey) return;
		stopEvent(event);
		void this.commit();
	}

	private async commit(): Promise<void> {
		const newName = this.input.value.trim();
		if (newName.length === 0) {
			this.status.textContent = "Name cannot be empty";
			return;
		}
		const request = this.request = new AbortController();
		try {
			const active = this.editor.getSelections()![0]!.getPosition();
			const edit = await this.service.provideRenameEdits(this.languageId, active, newName, request.signal);
			if (request.signal.aborted) return;
			await this.executeCommand(RenameCommandId, async () => {
				if (this.applyWorkspaceEdit) {
					await this.applyWorkspaceEdit(edit);
					return;
				}
				const documentEdit = edit.entries.find(candidate => candidate.kind === "textDocument" && candidate.resource.toString() === this.resource.toString());
				if (edit.entries.length !== 1 || !documentEdit || documentEdit.kind !== "textDocument") throw new Error("This editor host cannot apply a multi-resource rename");
				if (documentEdit.edits.length === 0) return;
				this.editor.pushUndoStop();
				this.editor.executeEdits(RenameCommandId, [...documentEdit.edits]);
				this.editor.pushUndoStop();
			});
			this.close();
		} catch (error) {
			if (!request.signal.aborted) this.onError(error);
		}
	}

	private close(): void {
		this.cancelRequest();
		this.element.hidden = true;
		this.editorInput.focus({ preventScroll: true });
	}

	private cancelRequest(): void {
		this.request?.abort();
		this.request = undefined;
	}
}

registerEditorContribution({ id: "editor.contrib.rename", commands: [{ id: RenameCommandId, canTriggerInlineEdits: true }], install: context => {
	if (context.kind !== "text") return;
	const service = context.register(new RenameService(context.model, context.options.input.resource, context.languageFeaturesService.renameProvider));
	context.register(new RenameController(
		context.controller.element,
		context.editor,
		context.view,
		service,
		context.languageId,
		context.options.input.resource,
		context.options.onApplyWorkspaceEdit,
		context.onLanguageError,
		context.executeCommand,
	));
} });
