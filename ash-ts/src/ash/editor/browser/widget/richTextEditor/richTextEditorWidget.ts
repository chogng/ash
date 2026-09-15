import './richTextEditorWidget.css';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isSafeInteger } from '../../../../base/common/numbers.js';
import { assertDefined } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { IDimension } from '../../../common/core/2d/dimension.js';
import { TextModel } from '../../../common/model/textModel.js';
import type { DocumentPlugin } from '../../../common/model/documentPlugin.js';
import { containsDocumentNode, findDocumentNode, type DocumentMark, type DocumentNode, type DocumentNodeId } from '../../../common/model/document.js';
import { createDocumentDecoration, type DocumentDecoration } from '../../../common/model/documentDecoration.js';
import { buildDocumentOutline, type DocumentOutline, type DocumentOutlineOptions } from '../../../common/model/documentOutline.js';
import { documentPointToPosition } from '../../../common/core/documentPosition.js';
import { documentSelectionToText } from '../../../common/model/documentText.js';
import { createDeleteAdjacentInlineNodeCommand, createDeleteInlineSelectionCommand, createDeleteNodeSelectionCommand, createDeleteTableColumnCommand, createDeleteTableRowCommand, createExitEmptyListItemCommand, createInsertFragmentCommand, createInsertHardBreakCommand, createInsertHorizontalRuleCommand, createInsertImageAtSelectionCommand, createInsertImageCommand, createInsertParagraphAfterCommand, createInsertTableColumnCommand, createInsertTableCommand, createInsertTableRowCommand, createJoinAdjacentBlockCommand, createJoinAdjacentListItemCommand, createJoinAdjacentTextRunCommand, createListItemIndentationCommand, createMoveBlockCommand, createRemoveMarkCommand, createPasteTextCommand, createReplaceTextCommand, createSetBlockTypeCommand, createSetLinkMarkCommand, createSetTextStyleCommand, createSplitBlockCommand, createSplitListItemCommand, createToggleBlockquoteCommand, createToggleListCommand, createToggleMarkCommand, findAdjacentTableCell, findTableCellContext, type DocumentCommand } from '../../../common/commands/documentCommands.js';
import { extractDocumentFragment } from '../../../common/model/documentFragment.js';
import { createDefaultDocumentSchema, type DocumentNodeKind, type DocumentSchema, type DocumentTextStyleAttributes } from '../../../common/model/documentSchema.js';
import { DOCUMENT_FRAGMENT_CLIPBOARD_MIME, deserializeDocumentFragment, serializeDocumentFragment } from '../../../common/model/documentSerialization.js';
import { allSelection, nodeSelection, textSelection, type DocumentSelection, type DocumentTextSelection } from '../../../common/core/documentSelection.js';
import { DocumentTransaction } from '../../../common/model/documentTransaction.js';
import { EditorDom } from '../../editorDom.js';
import { EditorExtensionsRegistry, type DocumentCollaborationContribution, type DocumentCollaborationStartResult, type DocumentFormattingContribution } from '../../editorExtensions.js';
import { DocumentOutlineNavigator } from '../documentOutlineNavigator.js';
import { DocumentCollaborationController } from '../../../contrib/collaboration/common/controller.js';
import { createDocumentFragmentFromHtml } from './htmlDocumentFragment.js';
import type { ITextModelResourceService, TextModelBlockInput, TextModelWorkingCopyReference } from '../../../common/services/textModelResourceService.js';
import type { IDocumentCollaborationService } from '../../../common/services/documentCollaborationService.js';
import type { DocumentCollaborationPresence } from '../../../common/services/documentCollaborationService.js';
import type { DocumentCollaborationInvite } from '../../../common/services/documentCollaborationService.js';
import type { DocumentCollaborationMember } from '../../../common/services/documentCollaborationService.js';
import type { DocumentCollaborationRoomRole } from '../../../common/services/documentCollaborationService.js';
import { h, fragment as createFragment } from '../../../../base/browser/dom.js';

export interface RichTextEditorOptions {
	readonly onSave?: () => Promise<void | boolean>;
	readonly plugins?: readonly DocumentPlugin<unknown>[];
	readonly schema?: DocumentSchema;
	/** Creates the canonical document when the loaded resource has no content. */
	readonly createEmptyDocument?: () => DocumentNode;
	/** Configures the generic heading query exposed by the pane. */
	readonly outline?: DocumentOutlineOptions;
	/** Adds the browser-owned outline navigator to the pane layout. */
	readonly outlineNavigator?: boolean;
	/** Supplies browser projections for profile-owned inline atomic nodes. */
	readonly inlineNodeViews?: Readonly<Record<string, InlineNodeViewFactory>>;
	/** Adds profile-owned commands to the shared block toolbar. */
	readonly toolbarActions?: readonly EditorToolbarAction[];
	readonly nodeViews?: Readonly<Record<string, NodeViewFactory>>;
	/** Optional room transport exposed through the collaboration contribution. */
	readonly documentCollaborationService?: IDocumentCollaborationService;
	/** Stable server-side schema compatibility identity for this editor profile. */
	readonly collaborationSchemaId?: string;
}

export interface NodeViewContext {
	readonly node: DocumentNode;
	readonly model: TextModel;
	readonly ownerDocument: Document;
	readonly previousElement: HTMLElement | undefined;
	readonly renderChildren: (parent: HTMLElement) => void;
}

export interface NodeView {
	readonly element: HTMLElement;
	readonly update?: (context: NodeViewContext) => boolean;
	readonly dispose?: () => void;
}

export type NodeViewFactory = (context: NodeViewContext) => HTMLElement | NodeView;

export interface InlineNodeViewContext {
	readonly node: DocumentNode;
	readonly model: TextModel;
	readonly ownerDocument: Document;
	readonly select: () => void;
}

export type InlineNodeViewFactory = (context: InlineNodeViewContext) => HTMLElement;

export interface EditorToolbarActionContext {
	readonly model: TextModel;
	readonly blockId: DocumentNodeId;
	readonly selection: DocumentTextSelection | undefined;
	readonly ownerDocument: Document;
}

export interface EditorToolbarAction {
	readonly id: string;
	readonly label: string;
	readonly run: (context: EditorToolbarActionContext) => DocumentCommand | undefined;
}

const DEFAULT_DOCUMENT_ACTIONS: readonly { readonly id: string; readonly label: string }[] = [
	{ id: "paragraph", label: "Paragraph" },
	{ id: "heading", label: "Heading" },
	{ id: "blockquote", label: "Blockquote" },
	{ id: "bulletList", label: "Bullet list" },
	{ id: "orderedList", label: "Ordered list" },
	{ id: "horizontalRule", label: "Rule" },
	{ id: "link", label: "Link" },
	{ id: "unlink", label: "Unlink" },
	{ id: "table", label: "Table" },
	{ id: "insertTableRow", label: "Add row" },
	{ id: "insertTableColumn", label: "Add column" },
	{ id: "deleteTableRow", label: "Delete row" },
	{ id: "deleteTableColumn", label: "Delete column" },
];

type CommandFocusBehavior = "focus-editor" | "preserve-focus";

interface RichTextEditorInput {
	readonly resource: URI;
	readonly initialText?: string;
	readonly readOnly?: boolean;
}

/**
 * One browser editor projected over a line-first TextModel with schema-backed rich semantics.
 *
 * The editor owns the schema-backed TextModel reference, working copy, DOM projection, and
 * block-level input. `EditorPane` owns Workbench pane lifecycle. Code blocks
 * edit line ranges in this same TextModel rather than creating nested models.
 */
export class RichTextEditorWidget extends Disposable {

	private readonly modelReferenceSlot = this._register(new MutableDisposable<TextModelWorkingCopyReference>());
	private readonly modelChangeListenerSlot = this._register(new MutableDisposable<IDisposable>());
	private readonly collaborationControllerSlot = this._register(new MutableDisposable<DocumentCollaborationController>());
	private readonly collaborationStateListenerSlot = this._register(new MutableDisposable<IDisposable>());
	private readonly collaborationPresenceListenerSlot = this._register(new MutableDisposable<IDisposable>());
	private readonly schema: DocumentSchema;
	private readonly nodeViewSlots = new Map<string, { readonly type: string; readonly view: NodeView }>();
	private editorDom: EditorDom | undefined;
	private container: HTMLDivElement | undefined;
	private formattingContribution: DocumentFormattingContribution | undefined;
	private collaborationContribution: DocumentCollaborationContribution | undefined;
	private outlineNavigator: DocumentOutlineNavigator | undefined;
	private input: RichTextEditorInput | undefined;
	private activeBlockId: string | undefined;
	private composition: DocumentComposition | undefined;
	private collaborationStart: AbortController | undefined;
	private remotePresences: readonly DocumentCollaborationPresence[] = [];
	private dimension: IDimension = { width: 0, height: 0 };

	get modelReference(): TextModelWorkingCopyReference | undefined {
		return this.modelReferenceSlot.value;
	}

	constructor(private readonly modelService: ITextModelResourceService<TextModelBlockInput, TextModelWorkingCopyReference>, private readonly options: RichTextEditorOptions = {}) {
		super();
		if (!modelService || typeof modelService.acquire !== "function") {
			this.dispose();
			throw new TypeError("Document editor requires a TextModel service");
		}
		this.schema = options.schema ?? createDefaultDocumentSchema();
		this._register(toDisposable(() => this.cancelCollaborationStart()));
		this._register(toDisposable(() => this.disposeNodeViews()));
	}

	create(parent: HTMLElement): void {
		if (this.container) throw new ReferenceError("Document editor has already been created");
		let formattingContribution: DocumentFormattingContribution | undefined;
		let collaborationContribution: DocumentCollaborationContribution | undefined;
		for (const contribution of EditorExtensionsRegistry.getEditorContributions()) {
			if ('ctor' in contribution) continue;
			contribution.install?.({
				kind: "document",
				container: parent,
				documentActions: [...DEFAULT_DOCUMENT_ACTIONS, ...(this.options.toolbarActions?.map(action => ({ id: action.id, label: action.label })) ?? [])],
				onToggleMark: markType => this.handleTextMarkAction(markType),
				onSetTextStyle: attrs => this.handleTextStyleAction(attrs),
				onClearTextStyle: () => this.handleClearTextStyleAction(),
				onRunDocumentAction: actionId => this.handleToolbarAction(actionId),
				onStartCollaboration: roomId => this.startCollaboration(roomId),
				onStopCollaboration: () => this.stopCollaboration(),
				onInviteCollaborator: (displayName, role) => this.createCollaborationInvite(displayName, role),
				onListCollaborators: () => this.listCollaborationMembers(),
				onRotateCollaboratorAccessToken: principalId => this.rotateCollaborationMemberAccessToken(principalId),
				onRevokeCollaborator: principalId => this.revokeCollaborationMember(principalId),
				setFormattingContribution: value => {
					if (formattingContribution) throw new Error("Document formatting contribution is already installed");
					formattingContribution = this._register(value);
				},
				setCollaborationContribution: value => {
					if (collaborationContribution) throw new Error("Document collaboration contribution is already installed");
					collaborationContribution = this._register(value);
				},
			});
		}
		const editorDom = this._register(new EditorDom({
			rootClassName: "ash-text-editor-widget-layout",
			contentClassName: "ash-text-editor-widget-pane",
		}));
		parent.append(...[collaborationContribution?.element, formattingContribution?.element].filter((element): element is HTMLElement => element !== undefined));
		editorDom.attach(parent);
		const container = editorDom.contentDomNode;
		const layoutContainer = editorDom.domNode;
		const outlineNavigator = this.options.outlineNavigator ? new DocumentOutlineNavigator(layoutContainer, { onSelect: nodeId => this.revealOutlineNode(nodeId) }) : undefined;
		if (outlineNavigator) layoutContainer.append(outlineNavigator.element);
		layoutContainer.append(container);
		collaborationContribution?.setState(this.options.documentCollaborationService ? "inactive" : "unavailable");
		this.collaborationContribution = collaborationContribution;
		this.formattingContribution = formattingContribution;
		this.editorDom = editorDom;
		this.container = container;
		this.outlineNavigator = outlineNavigator;
		const onSelectionChange = () => this.syncDocumentSelection();
		parent.ownerDocument.addEventListener("selectionchange", onSelectionChange);
		this._register(toDisposable(() => {
			parent.ownerDocument.removeEventListener("selectionchange", onSelectionChange);
			outlineNavigator?.dispose();
			collaborationContribution?.element.remove();
			this.collaborationContribution = undefined;
			formattingContribution?.element.remove();
			this.formattingContribution = undefined;
			this.editorDom = undefined;
			this.outlineNavigator = undefined;
			this.container = undefined;
		}));
	}

	async setInput(input: RichTextEditorInput, signal: AbortSignal): Promise<void> {
		const container = this.requireContainer();
		this.cancelCollaborationStart();
		throwIfCancelled(signal, "Document editor input loading was cancelled");
		const modelReference = await this.modelService.acquire({
			resource: input.resource,
			initialText: input.initialText,
			schema: this.schema,
			plugins: this.options.plugins,
			createEmptyDocument: this.options.createEmptyDocument,
			onSave: this.options.onSave,
		}, signal);
		if (signal.aborted) {
			modelReference.dispose();
			throwIfCancelled(signal, "Document editor input loading was cancelled");
		}
		const model = modelReference.model;
		this.collaborationStateListenerSlot.clear();
		this.collaborationPresenceListenerSlot.clear();
		this.collaborationControllerSlot.clear();
		this.remotePresences = [];
		this.modelChangeListenerSlot.clear();
		this.modelReferenceSlot.value = modelReference;
		this.modelChangeListenerSlot.value = model.onDidChangeBlocks(() => this.render());
		this.input = input;
		this.activeBlockId = undefined;
		container.replaceChildren();
		if (this.formattingContribution) this.formattingContribution.element.hidden = false;
		if (this.collaborationContribution) {
			this.collaborationContribution.element.hidden = false;
			this.collaborationContribution.setState(this.options.documentCollaborationService ? "inactive" : "unavailable");
		}
		this.render();
	}

	clearInput(): void {
		this.composition = undefined;
		this.cancelCollaborationStart();
		this.collaborationStateListenerSlot.clear();
		this.collaborationPresenceListenerSlot.clear();
		this.collaborationControllerSlot.clear();
		this.remotePresences = [];
		this.modelChangeListenerSlot.clear();
		this.modelReferenceSlot.clear();
		this.disposeNodeViews();
		this.input = undefined;
		this.activeBlockId = undefined;
		this.outlineNavigator?.setOutline([]);
		if (this.formattingContribution) this.formattingContribution.element.hidden = true;
		if (this.collaborationContribution) this.collaborationContribution.element.hidden = true;
		this.container?.replaceChildren();
	}

	layout(dimension: IDimension): void {
		this.dimension = { width: Math.max(0, dimension.width), height: Math.max(0, dimension.height) };
		this.editorDom?.layout(this.dimension);
	}

	focus(): void {
		this.container?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
	}

	async save(): Promise<void> {
		await this.requireWorkingCopy().save(new AbortController().signal);
	}

	async saveAs(resource: URI): Promise<void> {
		await this.requireWorkingCopy().saveAs(resource, new AbortController().signal);
	}

	async revert(): Promise<void> {
		await this.requireWorkingCopy().revert(new AbortController().signal);
	}

	get isDirty(): boolean {
		return this.modelReference?.isDirty ?? false;
	}

	get hasExternalChange(): boolean {
		return this.modelReference?.hasExternalChange ?? false;
	}

	getDocument(): DocumentNode {
		return this.requireModel().document;
	}

	/** Returns the current block-document selection, if the editor has input. */
	getDocumentSelection(): DocumentSelection | undefined {
		return this.modelReferenceSlot.value?.model.selection;
	}

	getOutline(): DocumentOutline {
		return buildDocumentOutline(this.requireModel().document, this.options.outline);
	}

	private revealOutlineNode(nodeId: string): void {
		const model = this.modelReferenceSlot.value?.model;
		const container = this.container;
		if (!model || !container) return;
		const target = Array.from(container.querySelectorAll<HTMLElement>("[data-node-id]")).find(element => element.dataset.nodeId === nodeId);
		if (!target) return;
		target.scrollIntoView?.({ block: "nearest" });
		const node = findNode(model.document, nodeId);
		if (node?.type === "paragraph" || node?.type === "heading") {
			this.focusBlockAtBoundary(model, nodeId, "forward");
			return;
		}
		target.focus();
	}

	private render(): void {
		const container = this.requireContainer();
		const model = this.modelReferenceSlot.value?.model;
		if (!model) return;
		const previousElements = new Map<string, HTMLElement>();
		for (const element of container.querySelectorAll<HTMLElement>("[data-node-id]")) {
			if (element.dataset.nodeId) previousElements.set(element.dataset.nodeId, element);
		}
		const activeNodeIds = new Set<string>();
		const decorations = resolveViewDecorations(model, remotePresenceDecorations(model.document, this.remotePresences));
		const fragment = createFragment(container.ownerDocument);
		for (const node of model.document.content) fragment.append(this.renderNode(node, model, previousElements, activeNodeIds, decorations));
		container.replaceChildren(fragment);
		this.outlineNavigator?.setOutline(this.getOutline());
		for (const [nodeId, slot] of this.nodeViewSlots) {
			if (activeNodeIds.has(nodeId)) continue;
			slot.view.dispose?.();
			this.nodeViewSlots.delete(nodeId);
		}
		this.updateToolbar();
		this.updateInlineNodeSelection();
	}

	private disposeNodeViews(): void {
		for (const slot of this.nodeViewSlots.values()) slot.view.dispose?.();
		this.nodeViewSlots.clear();
	}

	private renderNode(node: DocumentNode, model: TextModel, previousElements: Map<string, HTMLElement>, activeNodeIds: Set<string>, decorations: readonly ViewDecoration[]): HTMLElement {
		const document = this.requireContainer().ownerDocument;
		const nodeKind = this.schema.getNodeSpec(node.type)?.kind ?? "block";
		activeNodeIds.add(node.id);
		const nodeView = this.options.nodeViews?.[node.type];
		if (nodeView) {
			const context = { node, model, ownerDocument: document, previousElement: this.nodeViewSlots.get(node.id)?.view.element ?? previousElements.get(node.id), renderChildren: (parent: HTMLElement) => this.renderChildren(parent, node, model, previousElements, activeNodeIds, decorations) };
			const existing = this.nodeViewSlots.get(node.id);
			if (existing && existing.type !== node.type) {
				existing.view.dispose?.();
				this.nodeViewSlots.delete(node.id);
			}
			const current = this.nodeViewSlots.get(node.id);
			if (current?.view.update && !current.view.update(context)) {
				current.view.dispose?.();
				this.nodeViewSlots.delete(node.id);
			}
			const refreshed = this.nodeViewSlots.get(node.id);
			if (refreshed) {
				refreshed.view.element.dataset.nodeId = node.id;
				refreshed.view.element.dataset.nodeKind = nodeKind;
				return refreshed.view.element;
			}
			const created = normalizeNodeView(nodeView(context), node.type);
			if (created.dispose || created.update) this.nodeViewSlots.set(node.id, { type: node.type, view: created });
			created.element.dataset.nodeId = node.id;
			created.element.dataset.nodeKind = nodeKind;
			return created.element;
		}
		if (node.type === "horizontalRule") {
			const rule = this.reuseElement(node, previousElements, document, "hr");
			rule.dataset.nodeId = node.id;
			rule.className = "stanza-document-horizontal-rule";
			return rule;
		}
		const element = this.reuseElement(node, previousElements, document, nodeElementTagName(node));
		element.dataset.nodeId = node.id;
		element.dataset.nodeKind = nodeKind;
		switch (node.type) {
			case "paragraph":
				element.className = "stanza-document-paragraph";
				this.appendEditableText(element, node, model, decorations);
				break;
			case "heading":
				element.className = "stanza-document-heading";
				element.dataset.level = String(node.attrs.level ?? 1);
				this.appendEditableText(element, node, model, decorations);
				break;
			case "codeBlock":
				element.className = "stanza-document-code-block";
				element.dataset.editorKind = "code-block";
				this.appendEditableText(element, node, model, decorations);
				break;
			case "blockquote":
				element.className = "stanza-document-blockquote";
				this.renderChildren(element, node, model, previousElements, activeNodeIds, decorations);
				break;
			case "bulletList":
			case "orderedList":
				element.className = node.type === "bulletList" ? "stanza-document-list stanza-document-list-bullet" : "stanza-document-list stanza-document-list-ordered";
				this.renderChildren(element, node, model, previousElements, activeNodeIds, decorations);
				break;
			case "listItem":
				element.className = "stanza-document-list-item";
				this.renderChildren(element, node, model, previousElements, activeNodeIds, decorations);
				break;
			case "table":
				element.className = "stanza-document-table";
				this.renderChildren(element, node, model, previousElements, activeNodeIds, decorations);
				break;
			case "tableRow":
				element.className = "stanza-document-table-row";
				this.renderChildren(element, node, model, previousElements, activeNodeIds, decorations);
				break;
			case "tableCell":
				element.className = "stanza-document-table-cell";
				this.renderChildren(element, node, model, previousElements, activeNodeIds, decorations);
				break;
			default:
				element.className = documentNodeKindClassName(nodeKind);
				if (nodeKind === "line") this.appendEditableText(element, node, model, decorations);
				else this.renderChildren(element, node, model, previousElements, activeNodeIds, decorations);
				break;
		}
		return element;
	}

	private appendEditableText(element: HTMLElement, node: DocumentNode, model: TextModel, decorations: readonly ViewDecoration[]): void {
		if (usesRichTextSurface(node) || hasRenderableDecoration(model, node, decorations)) {
			this.appendRichText(element, node, model, decorations);
			return;
		}
		const textNode = node.content.find(child => child.text !== undefined);
		let textarea = element.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
		if (!textarea && element.childElementCount > 0) element.replaceChildren();
		const isNew = !textarea;
		textarea ??= h(element.ownerDocument, "textarea");
		textarea.className = "stanza-document-text-input";
		textarea.dataset.blockId = node.id;
		textarea.readOnly = this.isReadOnly();
		textarea.setAttribute("aria-label", editableBlockAriaLabel(node));
		textarea.setAttribute("aria-readonly", String(textarea.readOnly));
		const nextValue = textNode?.text ?? "";
		if (textarea.value !== nextValue) textarea.value = nextValue;
		textarea.rows = Math.max(1, textarea.value.split("\n").length);
		if (!isNew) return;
		textarea.addEventListener("focus", () => {
			this.activeBlockId = node.id;
			this.updateToolbar();
		});
		const syncTextareaSelection = () => {
			if (this.modelReferenceSlot.value?.model !== model) return;
			const start = textarea.selectionStart ?? 0;
			const end = textarea.selectionEnd ?? start;
			if (model.selection?.kind === "all" && start === 0 && end === textarea.value.length) return;
			const selection = createTextareaDocumentTextSelection(model.document, node.id, textarea);
			if (selection) model.setSelection(selection);
		};
		textarea.addEventListener("select", syncTextareaSelection);
		textarea.addEventListener("mouseup", syncTextareaSelection);
		textarea.addEventListener("keydown", event => this.handleTextKeydown(event, node, model, textarea));
		textarea.addEventListener("paste", event => this.handleTextPaste(event, model, node.id, textarea));
		textarea.addEventListener("copy", event => this.handleTextClipboard(event, model, node.id, textarea, false));
		textarea.addEventListener("cut", event => this.handleTextClipboard(event, model, node.id, textarea, true));
		textarea.addEventListener("compositionstart", () => this.beginComposition(model, node.id, textarea, createTextareaDocumentTextSelection(model.document, node.id, textarea)));
		textarea.addEventListener("compositionend", event => this.endComposition(event, textarea));
		textarea.addEventListener("compositioncancel", () => this.cancelComposition(textarea));
		textarea.addEventListener("input", () => {
			const currentModel = this.modelReferenceSlot.value?.model;
			if (currentModel !== model) return;
			if (this.isReadOnly()) return;
			if (this.composition?.element === textarea) return;
			if (currentModel.selection?.kind === "all") {
				const command = createReplaceTextCommand(currentModel.schema, currentModel.document, node.id, currentModel.selection, textarea.value, documentInsertionMarks(currentModel, currentModel.selection));
				if (command) this.dispatchCommand(currentModel, command, "typing");
				return;
			}
			const currentNode = findNode(currentModel.document, node.id);
			if (!currentNode) return;
			const currentText = currentNode.content.find(child => child.text !== undefined);
			const selectionStart = textarea.selectionStart ?? textarea.value.length;
			const selectionEnd = textarea.selectionEnd ?? selectionStart;
			if (!currentText) {
				if (textarea.value.length === 0) return;
				const inserted = currentModel.schema.createText(textarea.value, { id: `${node.id}-text`, marks: documentInsertionMarks(currentModel, currentModel.selection) ?? [] });
				currentModel.dispatch(new DocumentTransaction()
					.insertNode(node.id, 0, inserted)
					.withSelection(textSelection({ nodeId: inserted.id, offset: selectionEnd }))
					.withHistoryGroup("typing"));
			} else {
				let transaction = new DocumentTransaction().replaceText(currentText.id, 0, currentText.text?.length ?? 0, textarea.value, documentInsertionMarks(currentModel, currentModel.selection));
				if (textarea.value.length > 0) transaction = transaction.withSelection(textSelection({ nodeId: currentText.id, offset: selectionEnd }));
				currentModel.dispatch(transaction.withHistoryGroup("typing"));
			}
			const nextTextarea = findTextArea(this.requireContainer(), node.id);
			nextTextarea?.focus();
			if (nextTextarea) {
				nextTextarea.setSelectionRange(Math.min(selectionStart, nextTextarea.value.length), Math.min(selectionEnd, nextTextarea.value.length));
			}
		});
		element.append(textarea);
	}

	private appendRichText(element: HTMLElement, node: DocumentNode, model: TextModel, decorations: readonly ViewDecoration[]): void {
		let editor = element.querySelector<HTMLDivElement>("div.stanza-document-rich-text-input");
		if (!editor) {
			const createdEditor = h(element.ownerDocument, "div");
			editor = createdEditor;
			createdEditor.className = "stanza-document-rich-text-input";
			createdEditor.dataset.blockId = node.id;
			createdEditor.contentEditable = this.isReadOnly() ? "false" : "true";
			createdEditor.setAttribute("aria-label", editableBlockAriaLabel(node));
			createdEditor.setAttribute("aria-multiline", "true");
			createdEditor.setAttribute("aria-readonly", String(this.isReadOnly()));
			createdEditor.setAttribute("role", "textbox");
			createdEditor.addEventListener("beforeinput", event => this.handleRichTextBeforeInput(event as InputEvent, model, createdEditor));
			createdEditor.addEventListener("paste", event => this.handleRichTextPaste(event, model, createdEditor));
			createdEditor.addEventListener("copy", event => this.handleRichTextClipboard(event, model, false));
			createdEditor.addEventListener("cut", event => this.handleRichTextClipboard(event, model, true));
			createdEditor.addEventListener("keydown", event => this.handleRichTextKeydown(event, node, model, createdEditor));
			createdEditor.addEventListener("input", () => this.handleRichEditContext(createdEditor, model));
			createdEditor.addEventListener("focus", () => this.syncRichDocumentTextSelection(createdEditor, model));
			createdEditor.addEventListener("keyup", () => this.syncRichDocumentTextSelection(createdEditor, model));
			createdEditor.addEventListener("mouseup", () => this.syncRichDocumentTextSelection(createdEditor, model, true));
			createdEditor.addEventListener("compositionstart", () => this.beginComposition(model, node.id, createdEditor, readDocumentTextSelection(this.requireContainer(), true)?.selection ?? (model.selection?.kind === "text" ? model.selection : undefined)));
			createdEditor.addEventListener("compositionend", event => this.endComposition(event, createdEditor));
			createdEditor.addEventListener("compositioncancel", () => this.cancelComposition(createdEditor));
			element.replaceChildren(createdEditor);
		}
		editor.dataset.blockId = node.id;
		editor.setAttribute("aria-label", editableBlockAriaLabel(node));
		this.renderInlineContent(editor, node, model, decorations);
	}

	private renderInlineContent(editor: HTMLDivElement, node: DocumentNode, model: TextModel, decorations: readonly ViewDecoration[]): void {
		const fragment = createFragment(editor.ownerDocument);
		for (const child of node.content) {
			if (child.text !== undefined) {
				const linkMark = child.marks.find(mark => mark.type === "link");
				const textStyleMark = child.marks.find(mark => mark.type === "textStyle");
				const start = documentPointToPosition(model.document, model.schema, { nodeId: child.id, offset: 0 });
				const end = documentPointToPosition(model.document, model.schema, { nodeId: child.id, offset: child.text.length });
				const localDecorations = decorations.filter(decoration => decoration.to > start && decoration.from < end);
				const boundaries = new Set([0, child.text.length]);
				for (const decoration of localDecorations) {
					boundaries.add(Math.max(0, Math.min(child.text.length, decoration.from - start)));
					boundaries.add(Math.max(0, Math.min(child.text.length, decoration.to - start)));
				}
				const offsets = [...boundaries].sort((left, right) => left - right);
				for (let index = 0; index < Math.max(1, offsets.length - 1); index += 1) {
					const from = offsets[index] ?? 0;
					const to = offsets[index + 1] ?? child.text.length;
					if (to < from) continue;
					const activeDecorations = localDecorations.filter(decoration => decoration.from < start + to && decoration.to > start + from).map(decoration => decoration.decoration);
					const run = h(editor.ownerDocument, linkMark ? "a" : "span");
					run.className = "stanza-document-inline-run";
					run.dataset.textNodeId = child.id;
					for (const mark of child.marks) run.classList.add(`stanza-document-mark-${mark.type}`);
					applyTextStyleMark(run, textStyleMark);
					if (linkMark) {
						run.setAttribute("href", typeof linkMark.attrs.href === "string" ? linkMark.attrs.href : "");
						run.addEventListener("click", event => event.preventDefault());
					}
					run.textContent = child.text.slice(from, to);
					applyViewDecorations(run, activeDecorations);
					fragment.append(run);
				}
				continue;
			}
			if (child.type === "hardBreak") {
				fragment.append(h(editor.ownerDocument, "br"));
				continue;
			}
			if (child.type === "image") {
				const image = h(editor.ownerDocument, "img");
				image.className = "stanza-document-inline-image";
				image.dataset.inlineNodeId = child.id;
				image.draggable = false;
				image.alt = typeof child.attrs.alt === "string" ? child.attrs.alt : "";
				image.src = typeof child.attrs.src === "string" ? child.attrs.src : "";
				image.addEventListener("click", event => {
					event.preventDefault();
					this.selectInlineNode(model, node.id, child.id, editor);
				});
				fragment.append(image);
				continue;
			}
			const inlineFactory = this.options.inlineNodeViews?.[child.type];
			const inlineElement = inlineFactory
				? inlineFactory({ node: child, model, ownerDocument: editor.ownerDocument, select: () => this.selectInlineNode(model, node.id, child.id, editor) })
				: createFallbackInlineNode(editor.ownerDocument, child);
			if (!inlineElement || inlineElement.nodeType !== 1) throw new TypeError(`Inline node view '${child.type}' must return an HTMLElement`);
			inlineElement.dataset.inlineNodeId = child.id;
			inlineElement.dataset.inlineNodeType = child.type;
			inlineElement.addEventListener("click", event => {
				event.preventDefault();
				this.selectInlineNode(model, node.id, child.id, editor);
			});
			fragment.append(inlineElement);
		}
		editor.replaceChildren(fragment);
	}

	private handleRichEditContext(editor: HTMLDivElement, model: TextModel): void {
		if (this.modelReferenceSlot.value?.model !== model) return;
		if (this.isReadOnly() || !this.requireContainer().contains(editor) || this.composition?.element === editor) return;
		const blockId = editor.dataset.blockId;
		if (!blockId) return;
		const node = findNode(model.document, blockId);
		if (!node) return;
		const textNodes = node.content.filter(child => child.text !== undefined);
		const runs = Array.from(editor.querySelectorAll<HTMLElement>("[data-text-node-id]"));
		const runsById = new Map<string, HTMLElement[]>();
		for (const run of runs) {
			const nodeId = run.dataset.textNodeId;
			if (!nodeId) continue;
			const nodeRuns = runsById.get(nodeId) ?? [];
			nodeRuns.push(run);
			runsById.set(nodeId, nodeRuns);
		}
		if (textNodes.every(textNode => runsById.has(textNode.id)) && runsById.size === textNodes.length) {
			let transaction = new DocumentTransaction();
			for (const textNode of textNodes) {
				const nextText = (runsById.get(textNode.id) ?? []).map(run => run.textContent ?? "").join("");
				if (nextText !== textNode.text) transaction = transaction.replaceText(textNode.id, 0, textNode.text!.length, nextText);
			}
			if (transaction.steps.length > 0) model.dispatch(transaction.withHistoryGroup("typing"));
			return;
		}
		const text = editor.textContent ?? "";
		let transaction = new DocumentTransaction();
		for (const textNode of textNodes) transaction = transaction.deleteNode(textNode.id);
		if (text.length > 0) transaction = transaction.insertNode(node.id, 0, model.schema.createText(text, textNodes[0] ? { id: textNodes[0].id } : {}));
		if (transaction.steps.length > 0) model.dispatch(transaction.withHistoryGroup("typing"));
	}

	private beginComposition(model: TextModel, blockId: string, element: HTMLTextAreaElement | HTMLDivElement, selection: DocumentTextSelection | undefined): void {
		if (this.isReadOnly() || this.modelReferenceSlot.value?.model !== model || !selection || selection.kind !== "text") return;
		if (findTextBearingBlockId(model.document, selection.anchor.nodeId) !== blockId) return;
		this.composition = { model, blockId, element, selection, baseText: readCompositionText(element), version: model.version };
		if (model.selection?.kind !== "text" || model.selection.anchor.nodeId !== selection.anchor.nodeId || model.selection.anchor.offset !== selection.anchor.offset || model.selection.head.nodeId !== selection.head.nodeId || model.selection.head.offset !== selection.head.offset) model.setSelection(selection);
	}

	private endComposition(event: CompositionEvent, element: HTMLTextAreaElement | HTMLDivElement): void {
		const composition = this.composition;
		if (!composition || composition.element !== element) return;
		this.composition = undefined;
		const model = composition.model;
		if (this.isReadOnly() || this.modelReferenceSlot.value?.model !== model || model.version !== composition.version) {
			if (this.modelReferenceSlot.value?.model === model) this.render();
			return;
		}
		const currentText = readCompositionText(element);
		let selection = composition.selection;
		let replacement = event.data ?? "";
		if (replacement.length === 0 && currentText !== composition.baseText) {
			const diff = findCompositionDiff(composition.baseText, currentText);
			const textNode = findSingleTextNodeInBlock(model.document, composition.blockId);
			if (diff && textNode) {
				selection = textSelection({ nodeId: textNode.id, offset: diff.from }, { nodeId: textNode.id, offset: diff.to });
				replacement = diff.text;
			}
		}
		if (replacement.length === 0 && currentText === composition.baseText) return;
		const command = createReplaceTextCommand(model.schema, model.document, composition.blockId, selection, replacement, documentInsertionMarks(model, selection));
		if (!command) {
			this.render();
			return;
		}
		this.dispatchCommand(model, { ...command, transaction: command.transaction.withMeta("inputType", "insertCompositionText") }, "composition");
	}

	private cancelComposition(element: HTMLTextAreaElement | HTMLDivElement): void {
		if (this.composition?.element !== element) return;
		const model = this.composition.model;
		this.composition = undefined;
		if (this.modelReferenceSlot.value?.model === model) this.render();
	}

	private handleTextPaste(event: ClipboardEvent, model: TextModel, blockId: string, textarea: HTMLTextAreaElement): void {
		if (this.isReadOnly()) {
			event.preventDefault();
			return;
		}
		if (this.modelReferenceSlot.value?.model !== model) return;
		const image = findImageClipboardFile(event.clipboardData);
		if (image) {
			event.preventDefault();
			void this.insertPastedImage(model, blockId, image, createTextareaDocumentTextSelection(model.document, blockId, textarea));
			return;
		}
		const selection = model.selection?.kind === "all" ? model.selection : createTextareaDocumentTextSelection(model.document, blockId, textarea);
		const encodedFragment = event.clipboardData?.getData(DOCUMENT_FRAGMENT_CLIPBOARD_MIME);
		if (encodedFragment && selection) {
			let fragment;
			try {
				fragment = deserializeDocumentFragment(encodedFragment, model.schema);
			} catch {
				fragment = undefined;
			}
			const command = fragment ? createInsertFragmentCommand(model.schema, model.document, blockId, selection, fragment) : undefined;
			if (command) {
				event.preventDefault();
				this.dispatchCommand(model, command);
				return;
			}
		}
		const externalHtml = event.clipboardData?.getData("text/html");
		if (externalHtml && selection) {
			const fragment = createDocumentFragmentFromHtml(this.requireContainer().ownerDocument, model.schema, externalHtml);
			const command = fragment ? createInsertFragmentCommand(model.schema, model.document, blockId, selection, fragment) : undefined;
			if (command) {
				event.preventDefault();
				this.dispatchCommand(model, command);
				return;
			}
		}
		if (model.selection?.kind !== "all") return;
		const text = event.clipboardData?.getData("text/plain") ?? "";
		const command = createPasteTextCommand(model.schema, model.document, blockId, model.selection, text);
		if (!command) return;
		event.preventDefault();
		this.dispatchCommand(model, command);
	}

	private handleRichTextPaste(event: ClipboardEvent, model: TextModel, editor: HTMLDivElement): void {
		if (this.isReadOnly()) {
			event.preventDefault();
			return;
		}
		if (this.modelReferenceSlot.value?.model !== model) return;
		const image = findImageClipboardFile(event.clipboardData);
		const blockId = editor.dataset.blockId;
		if (image && blockId) {
			event.preventDefault();
			void this.insertPastedImage(model, blockId, image, readDocumentTextSelection(this.requireContainer(), true)?.selection);
			return;
		}
		if (!blockId) return;
		const selection = model.selection?.kind === "all" ? model.selection : readDocumentTextSelection(this.requireContainer(), true)?.selection;
		const encodedFragment = event.clipboardData?.getData(DOCUMENT_FRAGMENT_CLIPBOARD_MIME);
		let fragment;
		if (encodedFragment) {
			try {
				fragment = deserializeDocumentFragment(encodedFragment, model.schema);
			} catch {
				fragment = undefined;
			}
		}
		if (!fragment) {
			const externalHtml = event.clipboardData?.getData("text/html");
			if (externalHtml) fragment = createDocumentFragmentFromHtml(this.requireContainer().ownerDocument, model.schema, externalHtml);
		}
		const command = selection && fragment ? createInsertFragmentCommand(model.schema, model.document, blockId, selection, fragment) : undefined;
		if (command) {
			event.preventDefault();
			this.dispatchCommand(model, command);
			return;
		}
		const text = event.clipboardData?.getData("text/plain") ?? "";
		const textCommand = selection ? createPasteTextCommand(model.schema, model.document, blockId, selection, text, documentInsertionMarks(model, selection)) : undefined;
		if (!textCommand) return;
		event.preventDefault();
		this.dispatchCommand(model, textCommand);
	}

	private handleRichTextClipboard(event: ClipboardEvent, model: TextModel, cut: boolean): void {
		if (this.modelReferenceSlot.value?.model !== model) return;
		if (cut && this.isReadOnly()) {
			event.preventDefault();
			return;
		}
		if (model.selection?.kind !== "all") {
			const domSelection = readDocumentTextSelection(this.requireContainer(), true);
			if (domSelection) model.setSelection(domSelection.selection);
		}
		const selection = model.selection;
		if (!selection || (selection.kind === "text" && isCollapsedDocumentTextSelection(selection)) || selection.kind === "node") return;
		const text = documentSelectionToText(model.document, selection);
		if (text === undefined) return;
		const fragment = extractDocumentFragment(model.schema, model.document, selection);
		const encodedFragment = fragment ? serializeDocumentFragment(fragment, model.schema) : undefined;
		let command: DocumentCommand | undefined;
		if (cut) {
			const blockId = selection.kind === "all" ? findFirstEditableBlock(model.document)?.id : findTextBearingBlockId(model.document, selection.anchor.nodeId);
			if (!blockId) return;
			command = createDeleteInlineSelectionCommand(model.schema, model.document, blockId, selection) ?? createReplaceTextCommand(model.schema, model.document, blockId, selection, "");
			if (!command) return;
		}
		event.preventDefault();
		event.clipboardData?.setData("text/plain", text);
		if (encodedFragment) event.clipboardData?.setData(DOCUMENT_FRAGMENT_CLIPBOARD_MIME, encodedFragment);
		if (command) this.dispatchCommand(model, command);
	}

	private handleTextClipboard(event: ClipboardEvent, model: TextModel, blockId: string, textarea: HTMLTextAreaElement, cut: boolean): void {
		if (this.modelReferenceSlot.value?.model !== model) return;
		if (cut && this.isReadOnly()) {
			event.preventDefault();
			return;
		}
		if (model.selection?.kind !== "all") {
			const selection = createTextareaDocumentTextSelection(model.document, blockId, textarea);
			if (selection) model.setSelection(selection);
		}
		const selection = model.selection;
		if (!selection || (selection.kind === "text" && isCollapsedDocumentTextSelection(selection)) || selection.kind === "node") return;
		const text = documentSelectionToText(model.document, selection);
		if (text === undefined) return;
		const fragment = extractDocumentFragment(model.schema, model.document, selection);
		const encodedFragment = fragment ? serializeDocumentFragment(fragment, model.schema) : undefined;
		let command: DocumentCommand | undefined;
		if (cut) {
			command = createDeleteInlineSelectionCommand(model.schema, model.document, blockId, selection) ?? createReplaceTextCommand(model.schema, model.document, blockId, selection, "");
			if (!command) return;
		}
		event.preventDefault();
		event.clipboardData?.setData("text/plain", text);
		if (encodedFragment) event.clipboardData?.setData(DOCUMENT_FRAGMENT_CLIPBOARD_MIME, encodedFragment);
		if (command) this.dispatchCommand(model, command);
	}

	private async insertPastedImage(model: TextModel, blockId: string, image: File, selection?: DocumentTextSelection): Promise<void> {
		if (this.isReadOnly()) return;
		const ownerDocument = this.container?.ownerDocument;
		if (!ownerDocument) return;
		let src: string;
		try {
			src = await readBlobAsDataUrl(image, ownerDocument);
		} catch {
			return;
		}
		if (this.modelReferenceSlot.value?.model !== model) return;
		if (selection) model.setSelection(selection);
		const command = selection
			? createInsertImageAtSelectionCommand(model.schema, model.document, blockId, selection, src, image.name) ?? createInsertImageCommand(model.schema, model.document, blockId, src, image.name)
			: createInsertImageCommand(model.schema, model.document, blockId, src, image.name);
		if (command) this.dispatchCommand(model, command);
	}

	private handleRichTextBeforeInput(event: InputEvent, model: TextModel, editor: HTMLDivElement): void {
		if (this.isReadOnly() || this.modelReferenceSlot.value?.model !== model || event.isComposing || event.inputType === "insertCompositionText" || event.inputType === "deleteCompositionText") return;
		const blockId = editor.dataset.blockId;
		if (!blockId) return;
		if (model.selection?.kind === "all") {
			let command: DocumentCommand | undefined;
			if (event.inputType === "insertText" || event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop") {
				const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
				const marks = documentInsertionMarks(model, model.selection);
				command = event.inputType === "insertFromPaste" ? createPasteTextCommand(model.schema, model.document, blockId, model.selection, text, marks) : createReplaceTextCommand(model.schema, model.document, blockId, model.selection, text, marks);
			} else if (event.inputType === "deleteContentBackward" || event.inputType === "deleteContentForward") {
				command = createDeleteInlineSelectionCommand(model.schema, model.document, blockId, model.selection);
			}
			if (command) {
				event.preventDefault();
				this.dispatchCommand(model, command, event.inputType === "insertText" ? "typing" : undefined);
			}
			return;
		}
		if (model.selection?.kind === "node" && isInlineNodeInBlock(model.document, blockId, model.selection.nodeId) && (event.inputType === "deleteContentBackward" || event.inputType === "deleteContentForward")) {
			const command = createDeleteNodeSelectionCommand(model.document, model.selection);
			if (command) {
				event.preventDefault();
				this.dispatchCommand(model, command);
			}
			return;
		}
		if (event.inputType === "insertFromPaste") {
			const image = findImageClipboardFile(event.dataTransfer);
			if (image) {
				event.preventDefault();
				void this.insertPastedImage(model, blockId, image, readDocumentTextSelection(this.requireContainer(), true)?.selection);
				return;
			}
		}
		const inlineSelection = readDocumentTextSelection(this.requireContainer(), true);
		if (!inlineSelection) return;
		const selection = inlineSelection.selection;
		let command: DocumentCommand | undefined;
		if (event.inputType === "insertText" || event.inputType === "insertCompositionText" || event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop") {
			const text = event.data ?? event.dataTransfer?.getData("text/plain") ?? "";
			const marks = documentInsertionMarks(model, selection);
			if (text.length > 0) command = event.inputType === "insertFromPaste" && text.includes("\n")
				? createPasteTextCommand(model.schema, model.document, blockId, selection, text, marks)
				: createReplaceTextCommand(model.schema, model.document, blockId, selection, text, marks);
		} else if (event.inputType === "deleteContentBackward") {
			command = createDeleteBoundaryCommand(model, blockId, selection, "backward");
		} else if (event.inputType === "deleteContentForward") {
			command = createDeleteBoundaryCommand(model, blockId, selection, "forward");
		} else if (event.inputType === "insertLineBreak") {
			command = createInsertHardBreakCommand(model.schema, model.document, blockId, selection);
		} else if (event.inputType === "insertParagraph" && isCollapsedDocumentTextSelection(selection)) {
			command = createParagraphSplitCommand(model.schema, model.document, blockId, selection.anchor.nodeId, selection.anchor.offset);
		}
		if (!command) return;
		event.preventDefault();
		const historyGroup = event.inputType === "insertText" ? "typing" : event.inputType === "deleteContentBackward" ? "delete-backward" : event.inputType === "deleteContentForward" ? "delete-forward" : undefined;
		this.dispatchCommand(model, command, historyGroup);
	}

	private syncRichDocumentTextSelection(editor: HTMLDivElement, model: TextModel, force = false): void {
		if (this.modelReferenceSlot.value?.model !== model) return;
		const inlineSelection = readDocumentTextSelection(this.requireContainer(), true);
		if (inlineSelection && !isDocumentTextSelectionInDocument(model.document, inlineSelection.selection)) return;
		this.activeBlockId = inlineSelection?.blockId ?? editor.dataset.blockId;
		if (inlineSelection && !(model.selection?.kind === "all" && isCollapsedDocumentTextSelection(inlineSelection.selection) && !force)) model.setSelection(inlineSelection.selection);
		this.updateToolbar();
		this.updateInlineNodeSelection();
	}

	private syncDocumentSelection(): void {
		const model = this.modelReferenceSlot.value?.model;
		const container = this.container;
		if (!model || !container) return;
		const inlineSelection = readDocumentTextSelection(container, true);
		if (!inlineSelection) return;
		if (!isDocumentTextSelectionInDocument(model.document, inlineSelection.selection)) return;
		this.activeBlockId = inlineSelection.blockId;
		if (!(model.selection?.kind === "all" && isCollapsedDocumentTextSelection(inlineSelection.selection))) model.setSelection(inlineSelection.selection);
		this.updateToolbar();
		this.updateInlineNodeSelection();
	}

	private handleRichTextKeydown(event: KeyboardEvent, node: DocumentNode, model: TextModel, editor: HTMLDivElement): void {
		if (this.isReadOnly() || event.isComposing) return;
		if (this.handleHistoryShortcut(event, model)) return;
		if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a") {
			event.preventDefault();
			model.setSelection(allSelection());
			this.activeBlockId = node.id;
			this.updateToolbar();
			this.updateInlineNodeSelection();
			return;
		}
		if (model.selection?.kind === "all" && !event.metaKey && !event.ctrlKey && !event.altKey && (event.key === "Backspace" || event.key === "Delete")) {
			const command = createDeleteInlineSelectionCommand(model.schema, model.document, node.id, model.selection);
			if (command) {
				event.preventDefault();
				this.dispatchCommand(model, command, event.key === "Backspace" ? "delete-backward" : "delete-forward");
			}
			return;
		}
		const selectedNode = model.selection?.kind === "node" ? model.selection : undefined;
		if (selectedNode && node.content.some(child => child.id === selectedNode.nodeId)) {
			if (!event.metaKey && !event.ctrlKey && !event.altKey && (event.key === "Backspace" || event.key === "Delete")) {
				const command = createDeleteNodeSelectionCommand(model.document, selectedNode);
				if (command) {
					event.preventDefault();
					this.dispatchCommand(model, command);
				}
			}
			return;
		}
		const inlineSelection = readDocumentTextSelection(this.requireContainer(), true);
		if (!inlineSelection) return;
		const selection = inlineSelection.selection;
		const textNode = findNode(model.document, inlineSelection.nodeId);
		if (!textNode || textNode.text === undefined) return;
		const collapsed = isCollapsedDocumentTextSelection(selection);
		let command: DocumentCommand | undefined;
		if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey && collapsed) {
			if (this.handleTableCellTab(event, model, node.id)) return;
			command = createListItemIndentationForBlock(model.schema, model.document, node.id, event.shiftKey ? "out" : "in");
		} else if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === "b" || event.key === "B" || event.key === "i" || event.key === "I")) {
			command = createToggleMarkCommand(model.schema, model.document, node.id, inlineSelection.nodeId, selection, event.key.toLowerCase() === "b" ? "strong" : "em", {}, model.storedMarks);
		} else if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === "k" || event.key === "K") && !collapsed) {
			const href = editor.ownerDocument.defaultView?.prompt("Link URL", "https://");
			if (href) command = createSetLinkMarkCommand(model.schema, model.document, node.id, inlineSelection.nodeId, selection, href, model.storedMarks);
		} else if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key === "Enter" && event.shiftKey) {
			command = createInsertHardBreakCommand(model.schema, model.document, node.id, selection);
		} else if (!event.metaKey && !event.ctrlKey && event.key === "Enter" && !event.shiftKey && collapsed) {
			command = createParagraphSplitCommand(model.schema, model.document, node.id, inlineSelection.nodeId, selection.anchor.offset);
		} else if (!event.metaKey && !event.ctrlKey && !event.altKey && (event.key === "Backspace" || event.key === "Delete") && !collapsed) {
			command = createDeleteInlineSelectionCommand(model.schema, model.document, node.id, selection) ?? createReplaceTextCommand(model.schema, model.document, node.id, selection, "");
		} else if (!event.metaKey && !event.ctrlKey && event.key === "Backspace" && collapsed && selection.anchor.offset === 0) {
			command = createInlineBoundaryCommand(model.document, node.id, inlineSelection.nodeId, "backward");
		} else if (!event.metaKey && !event.ctrlKey && event.key === "Delete" && collapsed && selection.anchor.offset === textNode.text.length) {
			command = createInlineBoundaryCommand(model.document, node.id, inlineSelection.nodeId, "forward");
		}
		if (!command) return;
		event.preventDefault();
		const historyGroup = event.key === "Backspace" ? "delete-backward" : event.key === "Delete" ? "delete-forward" : undefined;
		this.dispatchCommand(model, command, historyGroup);
	}

	private handleTextKeydown(event: KeyboardEvent, node: DocumentNode, model: TextModel, textarea: HTMLTextAreaElement): void {
		const currentModel = this.modelReferenceSlot.value?.model;
		if (this.isReadOnly() || currentModel !== model || event.isComposing) return;
		if (this.handleHistoryShortcut(event, model)) return;
		if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a") {
			event.preventDefault();
			model.setSelection(allSelection());
			textarea.select();
			this.activeBlockId = node.id;
			this.updateToolbar();
			return;
		}
		if (model.selection?.kind === "all" && !event.metaKey && !event.ctrlKey && !event.altKey && (event.key === "Backspace" || event.key === "Delete")) {
			const command = createDeleteInlineSelectionCommand(model.schema, model.document, node.id, model.selection);
			if (command) {
				event.preventDefault();
				this.dispatchCommand(model, command, event.key === "Backspace" ? "delete-backward" : "delete-forward");
			}
			return;
		}
		const currentNode = findNode(model.document, node.id);
		if (!currentNode || (currentNode.type !== "paragraph" && currentNode.type !== "heading")) return;
		const textNode = currentNode.content.length === 1 && currentNode.content[0]?.text !== undefined ? currentNode.content[0] : undefined;
		const start = textarea.selectionStart ?? 0;
		const end = textarea.selectionEnd ?? start;
		let command: DocumentCommand | undefined;
		if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
			if (this.handleTableCellTab(event, model, node.id)) return;
			command = createListItemIndentationForBlock(model.schema, model.document, node.id, event.shiftKey ? "out" : "in");
		} else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
			command = createInsertParagraphAfterCommand(model.schema, model.document, node.id);
		} else if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && textNode && (event.key === "b" || event.key === "B" || event.key === "i" || event.key === "I")) {
			command = createToggleMarkCommand(model.schema, model.document, node.id, textNode.id, textSelection({ nodeId: textNode.id, offset: start }, { nodeId: textNode.id, offset: end }), event.key.toLowerCase() === "b" ? "strong" : "em", {}, model.storedMarks);
		} else if (event.altKey && !event.metaKey && !event.ctrlKey && event.key === "ArrowUp") {
			command = createMoveBlockCommand(model.document, node.id, "up");
		} else if (event.altKey && !event.metaKey && !event.ctrlKey && event.key === "ArrowDown") {
			command = createMoveBlockCommand(model.document, node.id, "down");
		} else if (event.key === "Enter" && event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
			command = createInsertHardBreakCommand(model.schema, model.document, node.id, createTextareaDocumentTextSelection(model.document, node.id, textarea));
		} else if (event.key === "Enter" && !event.shiftKey && start === end) {
			command = textNode
				? createParagraphSplitCommand(model.schema, model.document, node.id, textNode.id, start)
				: createParagraphSplitCommand(model.schema, model.document, node.id, "", 0) ?? createInsertParagraphAfterCommand(model.schema, model.document, node.id);
		} else if (event.key === "Backspace" && start === 0 && end === 0) {
			command = createJoinAdjacentBlockCommand(model.document, node.id, textNode?.id ?? "", "backward");
		} else if (event.key === "Delete" && textNode && start === textNode.text!.length && end === start) {
			command = createJoinAdjacentBlockCommand(model.document, node.id, textNode.id, "forward");
		}
		if (!command) return;
		event.preventDefault();
		const historyGroup = event.key === "Backspace" ? "delete-backward" : event.key === "Delete" ? "delete-forward" : undefined;
		this.dispatchCommand(model, command, historyGroup);
	}

	private handleHistoryShortcut(event: KeyboardEvent, model: TextModel): boolean {
		const action = historyShortcut(event);
		if (!action) return false;
		event.preventDefault();
		const change = action === "undo" ? model.undoBlocks() : model.redoBlocks();
		if (change) this.restoreModelFocus(model, change.selectionAfter);
		return true;
	}

	private restoreModelFocus(model: TextModel, selection: DocumentSelection | undefined): void {
		let blockId: string | undefined;
		if (selection?.kind === "text") blockId = findTextBearingBlockId(model.document, selection.anchor.nodeId);
		if (selection?.kind === "node") blockId = findTextBearingBlockContainingNode(model.document, selection.nodeId);
		if (!blockId && this.activeBlockId) {
			const active = findNode(model.document, this.activeBlockId);
			if (active) blockId = findFirstEditableBlock(active)?.id;
		}
		blockId ??= findFirstEditableBlock(model.document)?.id;
		if (!blockId) return;
		this.activeBlockId = blockId;
		const editor = findBlockEditor(this.requireContainer(), blockId);
		if (!editor) {
			this.updateToolbar();
			this.updateInlineNodeSelection();
			return;
		}
		editor.focus();
		if (selection?.kind === "text" && editor.tagName === "TEXTAREA") {
			const textarea = editor as HTMLTextAreaElement;
			const block = findNode(model.document, blockId);
			const textNode = block?.content.length === 1 && block.content[0]?.text !== undefined ? block.content[0] : undefined;
			if (textNode) {
				const anchor = Math.min(textNode.text!.length, selection.anchor.offset);
				const head = Math.min(textNode.text!.length, selection.head.offset);
				textarea.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), anchor <= head ? "forward" : "backward");
			}
		} else if (selection?.kind === "text" && editor.classList.contains("stanza-document-rich-text-input")) {
			setInlineDocumentTextSelection(this.requireContainer(), selection);
		}
		this.updateToolbar();
		this.updateInlineNodeSelection();
	}

	private selectInlineNode(model: TextModel, blockId: string, nodeId: string, editor: HTMLDivElement): void {
		if (this.modelReferenceSlot.value?.model !== model) return;
		editor.focus();
		model.setSelection(nodeSelection(nodeId));
		this.activeBlockId = blockId;
		this.updateInlineNodeSelection();
		this.updateToolbar();
	}

	private updateInlineNodeSelection(): void {
		const container = this.container;
		const model = this.modelReferenceSlot.value?.model;
		if (!container || !model) return;
		const selectedNodeId = model.selection?.kind === "node" ? model.selection.nodeId : undefined;
		for (const element of container.querySelectorAll<HTMLElement>("[data-inline-node-id]")) {
			const selected = element.dataset.inlineNodeId === selectedNodeId;
			element.classList.toggle("stanza-document-inline-node-selected", selected);
			element.setAttribute("aria-selected", String(selected));
		}
	}

	private handleTableCellTab(event: KeyboardEvent, model: TextModel, blockId: string): boolean {
		const context = findTableCellContext(model.document, blockId);
		if (!context) return false;
		event.preventDefault();
		const direction = event.shiftKey ? "backward" : "forward";
		const targetCellId = findAdjacentTableCell(model.document, context.cell.id, direction);
		if (targetCellId) {
			const targetCell = findNode(model.document, targetCellId);
			const targetBlock = targetCell ? findFirstEditableBlock(targetCell) : undefined;
			if (targetBlock) this.focusBlockAtBoundary(model, targetBlock.id, direction);
			return true;
		}
		if (direction === "forward") {
			const command = createInsertTableRowCommand(model.schema, model.document, context.table.id, context.table.content.length);
			if (command) this.dispatchCommand(model, command);
		}
		return true;
	}

	private focusBlockAtBoundary(model: TextModel, blockId: string, direction: "backward" | "forward"): void {
		const editor = findBlockEditor(this.requireContainer(), blockId);
		if (!editor) return;
		this.activeBlockId = blockId;
		editor.focus();
		const node = findNode(model.document, blockId);
		const textNode = node ? findFirstTextNode(node) : undefined;
		if (editor.tagName === "TEXTAREA") {
			const textarea = editor as HTMLTextAreaElement;
			const offset = direction === "backward" ? textarea.value.length : 0;
			textarea.setSelectionRange(offset, offset);
		} else if (textNode) {
			const offset = direction === "backward" ? textNode.text!.length : 0;
			const selection = textSelection({ nodeId: textNode.id, offset });
			model.setSelection(selection);
			setInlineDocumentTextSelection(editor as HTMLDivElement, selection);
		}
		this.updateToolbar();
	}

	private dispatchCommand(model: TextModel, command: DocumentCommand, historyGroup?: string, focusBehavior: CommandFocusBehavior = "focus-editor"): void {
		if (this.isReadOnly() || this.modelReferenceSlot.value?.model !== model) return;
		this.activeBlockId = command.focus.blockId;
		model.dispatch(historyGroup ? command.transaction.withHistoryGroup(historyGroup) : command.transaction);
		if (focusBehavior === "preserve-focus") {
			this.updateToolbar();
			this.updateInlineNodeSelection();
			return;
		}
		const editor = findBlockEditor(this.requireContainer(), command.focus.blockId);
		if (!editor) return;
		editor.focus();
		if (editor.tagName === "TEXTAREA") {
			const textarea = editor as HTMLTextAreaElement;
			const offset = command.focus.point?.offset ?? 0;
			textarea.setSelectionRange(Math.min(offset, textarea.value.length), Math.min(offset, textarea.value.length));
		} else if (editor.classList.contains("stanza-document-rich-text-input") && model.selection?.kind === "text") {
			setInlineDocumentTextSelection(this.requireContainer(), model.selection);
		}
		this.updateToolbar();
	}

	private handleToolbarAction(action: string): void {
		if (this.isReadOnly()) return;
		const model = this.modelReferenceSlot.value?.model;
		if (!model) return;
		const blockId = this.activeBlockId ?? findTextBearingBlockId(model.document, model.selection?.kind === "text" ? model.selection.anchor.nodeId : undefined) ?? findFirstEditableBlock(model.document)?.id;
		if (!blockId) return;
		const selection = this.readActiveDocumentTextSelection(model, blockId);
		const selectionBlockId = selection ? findTextBearingBlockId(model.document, selection.anchor.nodeId) : undefined;
		let command: DocumentCommand | undefined;
		switch (action) {
			case "paragraph":
			case "heading":
				command = createSetBlockTypeCommand(model.document, blockId, action);
				break;
			case "blockquote":
				command = createToggleBlockquoteCommand(this.schema, model.document, blockId);
				break;
			case "bulletList":
			case "orderedList":
				command = createToggleListCommand(this.schema, model.document, blockId, action);
				break;
			case "horizontalRule":
				command = createInsertHorizontalRuleCommand(this.schema, model.document, blockId);
				break;
			case "link": {
				if (!selection || !selectionBlockId) break;
				const href = this.requireContainer().ownerDocument.defaultView?.prompt("Link URL", "https://");
				if (href) command = createSetLinkMarkCommand(this.schema, model.document, selectionBlockId, selection.anchor.nodeId, selection, href, model.storedMarks);
				break;
			}
			case "unlink":
				if (selection && selectionBlockId) command = createRemoveMarkCommand(this.schema, model.document, selectionBlockId, selection.anchor.nodeId, selection, "link", model.storedMarks);
				break;
			case "table":
				command = createInsertTableCommand(this.schema, model.document, blockId);
				break;
			case "insertTableRow": {
				const context = findTableCellContext(model.document, blockId);
				if (context) command = createInsertTableRowCommand(this.schema, model.document, context.table.id, context.rowIndex + 1);
				break;
			}
			case "insertTableColumn": {
				const context = findTableCellContext(model.document, blockId);
				if (context) command = createInsertTableColumnCommand(this.schema, model.document, context.table.id, context.columnIndex + 1);
				break;
			}
			case "deleteTableRow": {
				const context = findTableCellContext(model.document, blockId);
				if (context) command = createDeleteTableRowCommand(model.document, context.table.id, context.row.id);
				break;
			}
			case "deleteTableColumn": {
				const context = findTableCellContext(model.document, blockId);
				if (context) command = createDeleteTableColumnCommand(model.document, context.table.id, context.columnIndex);
				break;
			}
		}
		if (!command) {
			const toolbarAction = this.options.toolbarActions?.find(candidate => candidate.id === action);
			if (toolbarAction) command = toolbarAction.run({ model, blockId, selection, ownerDocument: this.requireContainer().ownerDocument });
		}
		if (!command) return;
		this.dispatchCommand(model, command);
	}

	private handleTextMarkAction(markType: "strong" | "em"): void {
		if (this.isReadOnly()) return;
		const model = this.modelReferenceSlot.value?.model;
		if (!model) return;
		const blockId = this.activeBlockId ?? findTextBearingBlockId(model.document, model.selection?.kind === "text" ? model.selection.anchor.nodeId : undefined);
		if (!blockId) return;
		const block = findNode(model.document, blockId);
		if (!isTypographyBlock(block)) return;
		const selection = this.readActiveDocumentTextSelection(model, blockId);
		if (!selection) return;
		const command = createToggleMarkCommand(this.schema, model.document, blockId, selection.anchor.nodeId, selection, markType, {}, model.storedMarks);
		if (command) this.dispatchCommand(model, command, undefined, "preserve-focus");
	}

	private handleTextStyleAction(attrs: DocumentTextStyleAttributes): void {
		if (this.isReadOnly()) return;
		const model = this.modelReferenceSlot.value?.model;
		if (!model) return;
		const blockId = this.activeBlockId ?? findTextBearingBlockId(model.document, model.selection?.kind === "text" ? model.selection.anchor.nodeId : undefined);
		if (!blockId) return;
		const block = findNode(model.document, blockId);
		if (!isTypographyBlock(block)) return;
		const selection = this.readActiveDocumentTextSelection(model, blockId);
		if (!selection) return;
		const command = createSetTextStyleCommand(this.schema, model.document, blockId, selection.anchor.nodeId, selection, attrs, model.storedMarks);
		if (command) this.dispatchCommand(model, command, undefined, "preserve-focus");
	}

	private handleClearTextStyleAction(): void {
		if (this.isReadOnly()) return;
		const model = this.modelReferenceSlot.value?.model;
		if (!model) return;
		const blockId = this.activeBlockId ?? findTextBearingBlockId(model.document, model.selection?.kind === "text" ? model.selection.anchor.nodeId : undefined);
		if (!blockId) return;
		const block = findNode(model.document, blockId);
		if (!isTypographyBlock(block)) return;
		const selection = this.readActiveDocumentTextSelection(model, blockId);
		if (!selection) return;
		const command = createRemoveMarkCommand(this.schema, model.document, blockId, selection.anchor.nodeId, selection, "textStyle", model.storedMarks);
		if (command) this.dispatchCommand(model, command, undefined, "preserve-focus");
	}

	private readActiveDocumentTextSelection(model: TextModel, blockId: string): DocumentTextSelection | undefined {
		const modelSelection = model.selection;
		if (modelSelection?.kind === "text" && findTextBearingBlockId(model.document, modelSelection.anchor.nodeId) === blockId && isDocumentTextSelectionInDocument(model.document, modelSelection)) {
			return modelSelection;
		}
		const editor = findBlockEditor(this.requireContainer(), blockId);
		if (editor?.tagName === "TEXTAREA") {
			const selection = createTextareaDocumentTextSelection(model.document, blockId, editor as HTMLTextAreaElement);
			return selection;
		}
		if (editor?.classList.contains("stanza-document-rich-text-input")) {
			const inlineSelection = readDocumentTextSelection(this.requireContainer(), true);
			if (inlineSelection?.blockId === blockId && isDocumentTextSelectionInDocument(model.document, inlineSelection.selection)) {
				return inlineSelection.selection;
			}
		}
		return undefined;
	}

	private updateToolbar(): void {
		const toolbar = this.formattingContribution;
		const model = this.modelReferenceSlot.value?.model;
		if (!toolbar || !model) return;
		const blockId = this.activeBlockId ?? findTextBearingBlockId(model.document, model.selection?.kind === "text" ? model.selection.anchor.nodeId : undefined) ?? findFirstEditableBlock(model.document)?.id;
		if (blockId && !this.activeBlockId) this.activeBlockId = blockId;
		const block = blockId ? findNode(model.document, blockId) : undefined;
		const list = block ? findListForBlock(model.document, block.id) : undefined;
		const selection = model.selection?.kind === "text" ? model.selection : undefined;
		const selectionBlock = selection ? findNode(model.document, findTextBearingBlockId(model.document, selection.anchor.nodeId) ?? "") : undefined;
		const readOnly = this.isReadOnly();
		const checkedDocumentActionIds = new Set<string>();
		for (const { id: type } of DEFAULT_DOCUMENT_ACTIONS) {
			let checked = false;
			if (type === "paragraph" || type === "heading") checked = block?.type === type;
			else if (type === "blockquote") checked = block !== undefined && findBlockquoteForBlock(model.document, block.id) !== undefined;
			else if (type === "link") checked = selection !== undefined && (selectionBlock?.type === "paragraph" || selectionBlock?.type === "heading") && isDocumentTextSelectionMarked(selectionBlock, selection, "link", model.storedMarks);
			else checked = list?.type === type;
			if (checked) checkedDocumentActionIds.add(type);
		}
		const textContext = isTypographyBlock(block);
		const activeSelection = textContext ? this.readActiveDocumentTextSelection(model, block!.id) ?? selection : undefined;
		toolbar.setState({
			context: block?.type === "codeBlock" ? "code" : textContext ? "text" : "none",
			readOnly,
			bold: textContext && activeSelection ? isDocumentTextSelectionMarked(block!, activeSelection, "strong", model.storedMarks) : false,
			italic: textContext && activeSelection ? isDocumentTextSelectionMarked(block!, activeSelection, "em", model.storedMarks) : false,
			fontFamily: textContext && activeSelection ? selectedTextStyleFontFamily(block!, activeSelection, model.storedMarks) : undefined,
			fontSize: textContext && activeSelection ? selectedTextStyleFontSize(block!, activeSelection, model.storedMarks) : undefined,
			checkedDocumentActionIds,
		});
	}

	private renderChildren(element: HTMLElement, node: DocumentNode, model: TextModel, previousElements: Map<string, HTMLElement>, activeNodeIds: Set<string>, decorations: readonly ViewDecoration[]): void {
		const fragment = createFragment(element.ownerDocument);
		for (const child of node.content) fragment.append(this.renderNode(child, model, previousElements, activeNodeIds, decorations));
		element.replaceChildren(fragment);
	}

	private reuseElement(node: DocumentNode, previousElements: Map<string, HTMLElement>, document: Document, tagName: string): HTMLElement {
		const previous = previousElements.get(node.id);
		if (previous?.tagName.toLowerCase() === tagName) return previous;
		return h(document, tagName);
	}

	private requireContainer(): HTMLDivElement {
		const container = this.container;
		assertDefined(container, new ReferenceError("Document editor has not been created"));
		return container;
	}

	private requireModel(): TextModel {
		const model = this.modelReferenceSlot.value?.model;
		assertDefined(model, new ReferenceError("Document editor has no active model"));
		return model;
	}

	private async startCollaboration(roomId: string | undefined): Promise<DocumentCollaborationStartResult> {
		const service = this.options.documentCollaborationService;
		if (!service) throw new Error("Document collaboration is unavailable in this renderer");
		const model = this.requireModel();
		const input = this.requireInput();
		this.cancelCollaborationStart();
		this.collaborationStateListenerSlot.clear();
		this.collaborationPresenceListenerSlot.clear();
		this.collaborationControllerSlot.clear();
		this.remotePresences = [];
		const start = new AbortController();
		this.collaborationStart = start;
		try {
			const connection = await service.open({
				...(roomId === undefined ? {} : { roomId }),
				clientId: createCollaborationClientId(),
				schemaId: this.options.collaborationSchemaId ?? "stanza-document-v1",
				schema: model.schema,
				document: model.document,
			}, start.signal);
			if (start.signal.aborted || this.modelReferenceSlot.value?.model !== model) {
				connection.dispose();
				if (start.signal.aborted) throwIfCancelled(start.signal, 'Opening a document collaboration room was cancelled');
				throw new CancellationError('Opening a document collaboration room was cancelled');
			}
			const controller = new DocumentCollaborationController(model, connection);
			this.collaborationControllerSlot.value = controller;
			this.remotePresences = controller.presences;
			this.collaborationStateListenerSlot.value = controller.onDidChangeState(change => {
				if (this.collaborationControllerSlot.value !== controller) return;
				this.collaborationContribution?.setState(change.state, { roomId: change.roomId, principalId: controller.principalId, canManageMembers: controller.canManageMembers, ...(change.message === undefined ? {} : { message: change.message }) });
			});
			this.collaborationPresenceListenerSlot.value = controller.onDidChangePresence(change => {
				if (this.collaborationControllerSlot.value !== controller) return;
				this.remotePresences = change.presences;
				this.render();
			});
			this.render();
			return { roomId: controller.roomId, principalId: controller.principalId, canManageMembers: controller.canManageMembers };
		} finally {
			if (this.collaborationStart === start) this.collaborationStart = undefined;
		}
	}

	private stopCollaboration(): void {
		this.cancelCollaborationStart();
		this.collaborationStateListenerSlot.clear();
		this.collaborationPresenceListenerSlot.clear();
		this.collaborationControllerSlot.clear();
		this.remotePresences = [];
		this.collaborationContribution?.setState(this.options.documentCollaborationService ? "inactive" : "unavailable");
	}

	private createCollaborationInvite(displayName: string, role: DocumentCollaborationRoomRole): Promise<DocumentCollaborationInvite> {
		const controller = this.collaborationControllerSlot.value;
		if (!controller) return Promise.reject(new Error("Document collaboration is not connected"));
		return controller.createInvite(displayName, role);
	}

	private listCollaborationMembers(): Promise<readonly DocumentCollaborationMember[]> {
		const controller = this.collaborationControllerSlot.value;
		if (!controller) return Promise.reject(new Error("Document collaboration is not connected"));
		return controller.listMembers();
	}

	private rotateCollaborationMemberAccessToken(principalId: string): Promise<DocumentCollaborationInvite> {
		const controller = this.collaborationControllerSlot.value;
		if (!controller) return Promise.reject(new Error("Document collaboration is not connected"));
		return controller.rotateMemberAccessToken(principalId);
	}

	private revokeCollaborationMember(principalId: string): Promise<void> {
		const controller = this.collaborationControllerSlot.value;
		if (!controller) return Promise.reject(new Error("Document collaboration is not connected"));
		return controller.revokeMember(principalId);
	}

	private cancelCollaborationStart(): void {
		this.collaborationStart?.abort();
		this.collaborationStart = undefined;
	}

	private requireWorkingCopy(): TextModelWorkingCopyReference {
		const workingCopy = this.modelReferenceSlot.value;
		assertDefined(workingCopy, new ReferenceError("Document editor pane has no active working copy"));
		return workingCopy;
	}

	private requireInput(): RichTextEditorInput {
		const input = this.input;
		assertDefined(input, new ReferenceError("Document editor has no active input"));
		return input;
	}

	private isReadOnly(): boolean {
		return this.input?.readOnly === true || this.collaborationControllerSlot.value?.canEdit === false;
	}
}

function createFallbackInlineNode(ownerDocument: Document, node: DocumentNode): HTMLElement {
	const element = h(ownerDocument, "span");
	element.className = "stanza-document-inline-node";
	const label = node.attrs.label;
	element.textContent = typeof label === "string" && label.length > 0 ? label : `[${node.type}]`;
	return element;
}

function createCollaborationClientId(): string {
	return `stanza-${generateUuid()}`;
}

function editableBlockAriaLabel(node: DocumentNode): string {
	switch (node.type) {
		case "heading": {
			const level = node.attrs.level;
			return typeof level === "number" && Number.isInteger(level) && level > 0 ? `Heading level ${level}` : "Heading";
		}
		case "codeBlock": {
			const language = node.attrs.language;
			return typeof language === "string" && language.length > 0 ? `${language} code block` : "Code block";
		}
		case "paragraph": return "Paragraph";
		default: return `${node.type} text`;
	}
}

function applyTextStyleMark(element: HTMLElement, mark: DocumentMark | undefined): void {
	if (!mark) return;
	const fontFamily = mark.attrs.fontFamily;
	if (isTextStyleFontFamily(fontFamily)) element.dataset.fontFamily = fontFamily;
	const fontSize = mark.attrs.fontSize;
	if (isTextStyleFontSize(fontSize)) element.style.fontSize = `${fontSize}px`;
}

function isTypographyBlock(node: DocumentNode | undefined): node is DocumentNode {
	return node?.type === "paragraph" || node?.type === "heading";
}

function isDocumentTextSelectionInDocument(document: DocumentNode, selection: DocumentTextSelection): boolean {
	const anchor = findNode(document, selection.anchor.nodeId);
	const head = findNode(document, selection.head.nodeId);
	return anchor?.text !== undefined
		&& head?.text !== undefined
		&& selection.anchor.offset <= anchor.text.length
		&& selection.head.offset <= head.text.length;
}

function isTextStyleFontFamily(value: unknown): value is "sans" | "serif" | "monospace" {
	return value === "sans" || value === "serif" || value === "monospace";
}

function isTextStyleFontSize(value: unknown): value is number {
	return isSafeInteger(value) && value >= 8 && value <= 72;
}

function findNode(document: DocumentNode, id: string): DocumentNode | undefined {
	if (document.id === id) return document;
	for (const child of document.content) {
		const nested = findNode(child, id);
		if (nested) return nested;
	}
	return undefined;
}

function normalizeNodeView(value: HTMLElement | NodeView, nodeType: string): NodeView {
	if (!value || typeof value !== "object") throw new TypeError(`Node view '${nodeType}' must return an HTMLElement or node view handle`);
	if ("nodeType" in value) {
		if (value.nodeType !== 1) throw new TypeError(`Node view '${nodeType}' must return an HTMLElement`);
		return { element: value as HTMLElement };
	}
	if (!("element" in value) || !value.element || value.element.nodeType !== 1) throw new TypeError(`Node view '${nodeType}' must return an HTMLElement or node view handle`);
	const handle = value as NodeView;
	if (handle.update !== undefined && typeof handle.update !== "function") throw new TypeError(`Node view '${nodeType}' update must be a function`);
	if (handle.dispose !== undefined && typeof handle.dispose !== "function") throw new TypeError(`Node view '${nodeType}' dispose must be a function`);
	return handle;
}

function isInlineNodeInBlock(document: DocumentNode, blockId: string, nodeId: string): boolean {
	const block = findNode(document, blockId);
	return (block?.type === "paragraph" || block?.type === "heading") && block.content.some(child => child.id === nodeId && child.text === undefined);
}

function findTextArea(container: HTMLDivElement, blockId: string): HTMLTextAreaElement | undefined {
	for (const textarea of container.querySelectorAll<HTMLTextAreaElement>("textarea")) {
		if (textarea.dataset.blockId === blockId) return textarea;
	}
	return undefined;
}

function createTextareaDocumentTextSelection(document: DocumentNode, blockId: string, textarea: HTMLTextAreaElement): DocumentTextSelection | undefined {
	const block = findNode(document, blockId);
	const textNode = block?.content.length === 1 && block.content[0]?.text !== undefined ? block.content[0] : undefined;
	if (!textNode) return undefined;
	const start = Math.max(0, Math.min(textNode.text!.length, textarea.selectionStart ?? textarea.value.length));
	const end = Math.max(start, Math.min(textNode.text!.length, textarea.selectionEnd ?? start));
	return textSelection({ nodeId: textNode.id, offset: start }, { nodeId: textNode.id, offset: end });
}

function findBlockEditor(container: HTMLDivElement, blockId: string): HTMLElement | undefined {
	for (const editor of container.querySelectorAll<HTMLElement>("textarea, div.stanza-document-rich-text-input")) {
		if (editor.dataset.blockId === blockId) return editor;
	}
	return undefined;
}

function findFirstEditableBlock(node: DocumentNode): DocumentNode | undefined {
	if (node.type === "paragraph" || node.type === "heading" || node.type === "codeBlock") return node;
	for (const child of node.content) {
		const block = findFirstEditableBlock(child);
		if (block) return block;
	}
	return undefined;
}

function findFirstTextNode(node: DocumentNode): DocumentNode | undefined {
	if (node.text !== undefined) return node;
	for (const child of node.content) {
		const text = findFirstTextNode(child);
		if (text) return text;
	}
	return undefined;
}

function findImageClipboardFile(dataTransfer: DataTransfer | null | undefined): File | undefined {
	for (const file of Array.from(dataTransfer?.files ?? [])) {
		if (file.type.startsWith("image/")) return file;
	}
	for (const item of Array.from(dataTransfer?.items ?? [])) {
		if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
		const file = item.getAsFile();
		if (file) return file;
	}
	return undefined;
}

function readBlobAsDataUrl(blob: Blob, ownerDocument: Document): Promise<string> {
	const FileReaderConstructor = ownerDocument.defaultView?.FileReader;
	if (!FileReaderConstructor) return Promise.reject(new Error("FileReader is not available"));
	return new Promise((resolve, reject) => {
		const reader = new FileReaderConstructor();
		reader.addEventListener("load", () => {
			if (typeof reader.result === "string") resolve(reader.result);
			else reject(new Error("Image clipboard data did not produce a data URL"));
		});
		reader.addEventListener("error", () => reject(reader.error ?? new Error("Unable to read image clipboard data")));
		reader.readAsDataURL(blob);
	});
}

function historyShortcut(event: KeyboardEvent): "undo" | "redo" | undefined {
	if ((!event.metaKey && !event.ctrlKey) || event.altKey) return undefined;
	const key = event.key.toLowerCase();
	if (key === "z") return event.shiftKey ? "redo" : "undo";
	if (key === "y" && !event.shiftKey) return "redo";
	return undefined;
}

function usesRichTextSurface(node: DocumentNode): boolean {
	const textNodes = node.content.filter(child => child.text !== undefined);
	return node.content.some(child => child.text === undefined) || textNodes.length > 1 || textNodes.some(child => child.marks.length > 0);
}

interface ViewDecoration {
	readonly from: number;
	readonly to: number;
	readonly decoration: DocumentDecoration;
}

interface DocumentComposition {
	readonly model: TextModel;
	readonly blockId: string;
	readonly element: HTMLTextAreaElement | HTMLDivElement;
	readonly selection: DocumentTextSelection;
	readonly baseText: string;
	readonly version: number;
}

function readCompositionText(element: HTMLTextAreaElement | HTMLDivElement): string {
	return element.tagName === "TEXTAREA" ? (element as HTMLTextAreaElement).value : element.textContent ?? "";
}

function findCompositionDiff(before: string, after: string): { readonly from: number; readonly to: number; readonly text: string } | undefined {
	let from = 0;
	while (from < before.length && from < after.length && before[from] === after[from]) from += 1;
	let beforeEnd = before.length;
	let afterEnd = after.length;
	while (beforeEnd > from && afterEnd > from && before[beforeEnd - 1] === after[afterEnd - 1]) {
		beforeEnd -= 1;
		afterEnd -= 1;
	}
	if (from === beforeEnd && from === afterEnd) return undefined;
	return { from, to: beforeEnd, text: after.slice(from, afterEnd) };
}

function findSingleTextNodeInBlock(document: DocumentNode, blockId: string): DocumentNode | undefined {
	const block = findNode(document, blockId);
	if (!block) return undefined;
	const textNodes = block.content.filter(child => child.text !== undefined);
	return textNodes.length === 1 ? textNodes[0] : undefined;
}

function resolveViewDecorations(model: TextModel, externalDecorations: readonly DocumentDecoration[] = []): readonly ViewDecoration[] {
	const result: ViewDecoration[] = [];
	const decorations = [...model.getPluginDecorations().flatMap(source => source.set.decorations), ...externalDecorations];
	for (const decoration of decorations) {
		try {
			const from = documentPointToPosition(model.document, model.schema, decoration.from);
			const to = documentPointToPosition(model.document, model.schema, decoration.to);
			if (from === to) continue;
			result.push({ from: Math.min(from, to), to: Math.max(from, to), decoration });
		} catch {
			// A stale plugin or remote-presence range is ignored until it is replaced.
		}
	}
	return Object.freeze(result);
}

function remotePresenceDecorations(document: DocumentNode, presences: readonly DocumentCollaborationPresence[]): readonly DocumentDecoration[] {
	const decorations: DocumentDecoration[] = [];
	for (const presence of presences) {
		if (presence.selection.kind !== "text") continue;
		let from = presence.selection.anchor;
		let to = presence.selection.head;
		if (from.nodeId === to.nodeId && from.offset === to.offset) {
			const text = findNode(document, from.nodeId)?.text;
			if (!text) continue;
			if (from.offset < text.length) to = { nodeId: from.nodeId, offset: from.offset + 1 };
			else if (from.offset > 0) from = { nodeId: from.nodeId, offset: from.offset - 1 };
			else continue;
		}
		decorations.push(createDocumentDecoration({
			id: `remote-presence-${presence.clientId}`,
			from,
			to,
			className: `stanza-document-remote-selection stanza-document-remote-selection-${presenceColorIndex(presence.clientId)}`,
			attrs: { "data-collaboration-client": presence.clientId },
		}));
	}
	return Object.freeze(decorations);
}

function presenceColorIndex(clientId: string): number {
	let hash = 0;
	for (let index = 0; index < clientId.length; index += 1) hash = (hash * 31 + clientId.charCodeAt(index)) >>> 0;
	return hash % 4;
}

function hasRenderableDecoration(model: TextModel, node: DocumentNode, decorations: readonly ViewDecoration[]): boolean {
	for (const child of node.content) {
		if (child.text === undefined || child.text.length === 0) continue;
		const start = documentPointToPosition(model.document, model.schema, { nodeId: child.id, offset: 0 });
		const end = documentPointToPosition(model.document, model.schema, { nodeId: child.id, offset: child.text.length });
		if (decorations.some(decoration => decoration.to > start && decoration.from < end)) return true;
	}
	return false;
}

function applyViewDecorations(element: HTMLElement, decorations: readonly DocumentDecoration[]): void {
	if (decorations.length === 0) return;
	element.classList.add("stanza-document-decoration");
	element.dataset.decorationIds = decorations.map(decoration => decoration.id).join(" ");
	for (const decoration of decorations) {
		for (const className of decoration.className?.split(/\s+/) ?? []) {
			if (/^-?[A-Za-z_][A-Za-z0-9_-]*$/.test(className)) element.classList.add(className);
		}
		for (const [key, value] of Object.entries(decoration.attrs)) {
			if (!/^data-[a-z0-9_-]+$/i.test(key) || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) continue;
			element.setAttribute(key, String(value));
		}
	}
}

function nodeElementTagName(node: DocumentNode): string {
	switch (node.type) {
		case "heading": return "h2";
		case "blockquote": return "blockquote";
		case "bulletList": return "ul";
		case "orderedList": return "ol";
		case "listItem": return "li";
		case "table": return "table";
		case "tableRow": return "tr";
		case "tableCell": return "td";
		default: return "div";
	}
}

function documentNodeKindClassName(kind: DocumentNodeKind): string {
	return `stanza-document-${kind}`;
}

function findTextBearingBlockId(root: DocumentNode, textNodeId: string | undefined): string | undefined {
	if (!textNodeId) return undefined;
	if ((root.type === "paragraph" || root.type === "heading" || root.type === "codeBlock") && root.content.some(child => child.id === textNodeId)) return root.id;
	for (const child of root.content) {
		const blockId = findTextBearingBlockId(child, textNodeId);
		if (blockId) return blockId;
	}
	return undefined;
}

function findTextBearingBlockContainingNode(root: DocumentNode, nodeId: string): string | undefined {
	if ((root.type === "paragraph" || root.type === "heading" || root.type === "codeBlock") && containsDocumentNode(root, nodeId)) return root.id;
	for (const child of root.content) {
		const blockId = findTextBearingBlockContainingNode(child, nodeId);
		if (blockId) return blockId;
	}
	return undefined;
}

function findListForBlock(root: DocumentNode, blockId: string): DocumentNode | undefined {
	for (const child of root.content) {
		if ((child.type === "bulletList" || child.type === "orderedList") && containsDocumentNode(child, blockId)) return child;
		const list = findListForBlock(child, blockId);
		if (list) return list;
	}
	return undefined;
}

function findBlockquoteForBlock(root: DocumentNode, blockId: string): DocumentNode | undefined {
	for (const child of root.content) {
		if (child.type === "blockquote" && containsDocumentNode(child, blockId)) return child;
		const blockquote = findBlockquoteForBlock(child, blockId);
		if (blockquote) return blockquote;
	}
	return undefined;
}

function isDocumentTextSelectionMarked(block: DocumentNode, selection: DocumentTextSelection, markType: string, storedMarks?: readonly DocumentMark[]): boolean {
	const anchorIndex = block.content.findIndex(child => child.id === selection.anchor.nodeId && child.text !== undefined);
	const headIndex = block.content.findIndex(child => child.id === selection.head.nodeId && child.text !== undefined);
	if (anchorIndex < 0 || headIndex < 0) return false;
	const anchorNode = block.content[anchorIndex]!;
	const headNode = block.content[headIndex]!;
	if (selection.anchor.offset > anchorNode.text!.length || selection.head.offset > headNode.text!.length) return false;
	if (anchorIndex === headIndex && selection.anchor.offset === selection.head.offset) {
		return (storedMarks ?? anchorNode.marks).some(mark => mark.type === markType);
	}
	const forward = anchorIndex < headIndex || (anchorIndex === headIndex && selection.anchor.offset <= selection.head.offset);
	const startIndex = forward ? anchorIndex : headIndex;
	const endIndex = forward ? headIndex : anchorIndex;
	const startOffset = forward ? selection.anchor.offset : selection.head.offset;
	const endOffset = forward ? selection.head.offset : selection.anchor.offset;
	let selectedText = false;
	for (let index = startIndex; index <= endIndex; index += 1) {
		const node = block.content[index]!;
		if (node.text === undefined) return false;
		const from = index === startIndex ? startOffset : 0;
		const to = index === endIndex ? endOffset : node.text.length;
		if (to <= from) continue;
		selectedText = true;
		if (!node.marks.some(mark => mark.type === markType)) return false;
	}
	return selectedText;
}

function selectedTextStyleFontFamily(block: DocumentNode, selection: DocumentTextSelection, storedMarks?: readonly DocumentMark[]): "sans" | "serif" | "monospace" | undefined {
	return selectedTextStyleAttribute(block, selection, "fontFamily", isTextStyleFontFamily, storedMarks);
}

function selectedTextStyleFontSize(block: DocumentNode, selection: DocumentTextSelection, storedMarks?: readonly DocumentMark[]): number | undefined {
	return selectedTextStyleAttribute(block, selection, "fontSize", isTextStyleFontSize, storedMarks);
}

function selectedTextStyleAttribute<T extends string | number>(block: DocumentNode, selection: DocumentTextSelection, attribute: "fontFamily" | "fontSize", isValid: (value: unknown) => value is T, storedMarks?: readonly DocumentMark[]): T | undefined {
	const anchorIndex = block.content.findIndex(child => child.id === selection.anchor.nodeId && child.text !== undefined);
	const headIndex = block.content.findIndex(child => child.id === selection.head.nodeId && child.text !== undefined);
	if (anchorIndex < 0 || headIndex < 0) return undefined;
	const anchorNode = block.content[anchorIndex]!;
	const headNode = block.content[headIndex]!;
	if (selection.anchor.offset > anchorNode.text!.length || selection.head.offset > headNode.text!.length) return undefined;
	if (anchorIndex === headIndex && selection.anchor.offset === selection.head.offset) {
		return readTextStyleAttribute(storedMarks ?? anchorNode.marks, attribute, isValid);
	}
	const forward = anchorIndex < headIndex || (anchorIndex === headIndex && selection.anchor.offset <= selection.head.offset);
	const startIndex = forward ? anchorIndex : headIndex;
	const endIndex = forward ? headIndex : anchorIndex;
	const startOffset = forward ? selection.anchor.offset : selection.head.offset;
	const endOffset = forward ? selection.head.offset : selection.anchor.offset;
	let value: T | undefined;
	let hasValue = false;
	for (let index = startIndex; index <= endIndex; index += 1) {
		const node = block.content[index]!;
		if (node.text === undefined) return undefined;
		const from = index === startIndex ? startOffset : 0;
		const to = index === endIndex ? endOffset : node.text.length;
		if (to <= from) continue;
		const nextValue = readTextStyleAttribute(node.marks, attribute, isValid);
		if (nextValue === undefined || (hasValue && nextValue !== value)) return undefined;
		value = nextValue;
		hasValue = true;
	}
	return hasValue ? value : undefined;
}

function readTextStyleAttribute<T extends string | number>(marks: readonly DocumentMark[], attribute: "fontFamily" | "fontSize", isValid: (value: unknown) => value is T): T | undefined {
	const value = marks.find(mark => mark.type === "textStyle")?.attrs[attribute];
	return isValid(value) ? value : undefined;
}

interface DomDocumentTextSelection {
	readonly blockId: string;
	readonly nodeId: string;
	readonly selection: DocumentTextSelection;
}

function readDocumentTextSelection(container: HTMLDivElement, includeCollapsed = false): DomDocumentTextSelection | undefined {
	const selection = container.ownerDocument.getSelection();
	if (!selection || selection.rangeCount === 0 || (!includeCollapsed && selection.isCollapsed)) return undefined;
	const anchorRun = findInlineRun(container, selection.anchorNode);
	const headRun = findInlineRun(container, selection.focusNode);
	const anchorEditor = anchorRun ? findRichTextEditor(container, anchorRun) : undefined;
	const headEditor = headRun ? findRichTextEditor(container, headRun) : undefined;
	if (!anchorRun || !headRun || !anchorEditor || !headEditor || !anchorRun.dataset.textNodeId || !headRun.dataset.textNodeId || !anchorEditor.dataset.blockId) return undefined;
	const anchorOffset = offsetWithinInlineRun(container, anchorRun, selection.anchorNode, selection.anchorOffset);
	const headOffset = offsetWithinInlineRun(container, headRun, selection.focusNode, selection.focusOffset);
	return {
		blockId: anchorEditor.dataset.blockId,
		nodeId: anchorRun.dataset.textNodeId,
		selection: textSelection({ nodeId: anchorRun.dataset.textNodeId, offset: anchorOffset }, { nodeId: headRun.dataset.textNodeId, offset: headOffset }),
	};
}

function readInlineDocumentTextSelection(editor: HTMLDivElement, includeCollapsed = false): { nodeId: string; selection: DocumentTextSelection } | undefined {
	const selection = readDocumentTextSelection(editor, includeCollapsed);
	if (!selection || selection.blockId !== editor.dataset.blockId) return undefined;
	return { nodeId: selection.nodeId, selection: selection.selection };
}

function findInlineRun(editor: HTMLDivElement, node: Node | null): HTMLElement | undefined {
	let current = node;
	while (current && current !== editor) {
		if (current.nodeType === 1) {
			const element = current as HTMLElement;
			if (element.dataset.textNodeId) return element;
		}
		current = current.parentNode;
	}
	return undefined;
}

function findRichTextEditor(container: HTMLDivElement, node: Node): HTMLDivElement | undefined {
	let current: Node | null = node;
	while (current) {
		if (current.nodeType === 1) {
			const element = current as HTMLElement;
			if (element.classList.contains("stanza-document-rich-text-input")) return element as HTMLDivElement;
		}
		if (current === container) break;
		current = current.parentNode;
	}
	return container.classList.contains("stanza-document-rich-text-input") ? container : undefined;
}

function offsetWithinInlineRun(editor: HTMLDivElement, run: HTMLElement, node: Node | null, offset: number): number {
	if (!node) return 0;
	const nodeId = run.dataset.textNodeId;
	let offsetBefore = 0;
	if (nodeId) {
		for (const candidate of editor.querySelectorAll<HTMLElement>("[data-text-node-id]")) {
			if (candidate.dataset.textNodeId !== nodeId) continue;
			if (candidate === run) break;
			offsetBefore += candidate.textContent?.length ?? 0;
		}
	}
	const range = editor.ownerDocument.createRange();
	range.selectNodeContents(run);
	range.setEnd(node, offset);
	return offsetBefore + range.toString().length;
}

function setInlineDocumentTextSelection(editor: HTMLDivElement, selection: DocumentTextSelection): void {
	const anchorPosition = findInlineRunAtOffset(editor, selection.anchor.nodeId, selection.anchor.offset);
	const headPosition = findInlineRunAtOffset(editor, selection.head.nodeId, selection.head.offset);
	if (!anchorPosition || !headPosition) return;
	const anchorRun = anchorPosition.run;
	const headRun = headPosition.run;
	const anchorText = anchorRun.firstChild ?? anchorRun;
	const headText = headRun.firstChild ?? headRun;
	const anchorOffset = anchorPosition.offset;
	const headOffset = headPosition.offset;
	const domSelection = editor.ownerDocument.getSelection();
	if (domSelection?.setBaseAndExtent) {
		domSelection.removeAllRanges();
		try {
			domSelection.setBaseAndExtent(anchorText, anchorOffset, headText, headOffset);
			return;
		} catch {
			// Fall back to a normalized range for DOM implementations without full contenteditable support.
		}
	}
	const range = editor.ownerDocument.createRange();
	const forward = anchorRun === headRun ? anchorOffset <= headOffset : (anchorRun.compareDocumentPosition(headRun) & 4) !== 0;
	if (forward) {
		range.setStart(anchorText, anchorOffset);
		range.setEnd(headText, headOffset);
	} else {
		range.setStart(headText, headOffset);
		range.setEnd(anchorText, anchorOffset);
	}
	domSelection?.removeAllRanges();
	domSelection?.addRange(range);
}

function findInlineRunAtOffset(editor: HTMLDivElement, nodeId: string, offset: number): { readonly run: HTMLElement; readonly offset: number } | undefined {
	const runs = [...editor.querySelectorAll<HTMLElement>("[data-text-node-id]")].filter(run => run.dataset.textNodeId === nodeId);
	if (runs.length === 0) return undefined;
	let remaining = Math.max(0, offset);
	for (let index = 0; index < runs.length; index += 1) {
		const run = runs[index]!;
		const length = run.textContent?.length ?? 0;
		if (remaining <= length || index === runs.length - 1) return { run, offset: Math.min(remaining, length) };
		remaining -= length;
	}
	return undefined;
}

function createInlineBoundaryCommand(document: DocumentNode, blockId: string, textNodeId: string, direction: "backward" | "forward"): DocumentCommand | undefined {
	const block = findNode(document, blockId);
	if (!block) return undefined;
	const index = block.content.findIndex(child => child.id === textNodeId);
	const adjacent = block.content[index + (direction === "backward" ? -1 : 1)];
	if (index >= 0 && adjacent?.text !== undefined) return createJoinAdjacentTextRunCommand(document, blockId, textNodeId, direction);
	if (index >= 0 && adjacent && adjacent.text === undefined) return createDeleteAdjacentInlineNodeCommand(document, blockId, textNodeId, direction);
	const blockCommand = createJoinAdjacentBlockCommand(document, blockId, textNodeId, direction);
	if (blockCommand) return blockCommand;
	const location = findDocumentNode(document, blockId);
	const parent = location?.parent;
	if (parent?.type !== "listItem") return undefined;
	const blockIndex = parent.content.findIndex(child => child.id === blockId);
	const atBoundary = direction === "backward" ? blockIndex === 0 : blockIndex === parent.content.length - 1;
	return atBoundary ? createJoinAdjacentListItemCommand(document, parent.id, blockId, direction) : undefined;
}

function createParagraphSplitCommand(schema: DocumentSchema, document: DocumentNode, paragraphId: string, textNodeId: string, offset: number): DocumentCommand | undefined {
	const location = findDocumentNode(document, paragraphId);
	if (location?.parent?.type === "listItem") {
		if (!textNodeId) return createExitEmptyListItemCommand(schema, document, location.parent.id, paragraphId);
		return createSplitListItemCommand(schema, document, location.parent.id, paragraphId, textNodeId, offset);
	}
	if (!textNodeId) return undefined;
	return createSplitBlockCommand(schema, document, paragraphId, textNodeId, offset);
}

function createListItemIndentationForBlock(schema: DocumentSchema, document: DocumentNode, paragraphId: string, direction: "in" | "out"): DocumentCommand | undefined {
	const location = findDocumentNode(document, paragraphId);
	if (location?.parent?.type !== "listItem") return undefined;
	return createListItemIndentationCommand(schema, document, location.parent.id, paragraphId, direction);
}

function createDeleteBoundaryCommand(model: TextModel, blockId: string, selection: DocumentTextSelection, direction: "backward" | "forward"): DocumentCommand | undefined {
	if (!isCollapsedDocumentTextSelection(selection)) return createDeleteInlineSelectionCommand(model.schema, model.document, blockId, selection) ?? createReplaceTextCommand(model.schema, model.document, blockId, selection, "");
	const point = selection.anchor;
	const textNode = findNode(model.document, point.nodeId);
	if (!textNode || textNode.text === undefined) return undefined;
	if (direction === "backward" && point.offset > 0) {
		return createReplaceTextCommand(model.schema, model.document, blockId, textSelection({ nodeId: point.nodeId, offset: point.offset - 1 }, point), "");
	}
	if (direction === "forward" && point.offset < textNode.text.length) {
		return createReplaceTextCommand(model.schema, model.document, blockId, textSelection(point, { nodeId: point.nodeId, offset: point.offset + 1 }), "");
	}
	return createInlineBoundaryCommand(model.document, blockId, point.nodeId, direction);
}

function isCollapsedDocumentTextSelection(selection: DocumentTextSelection): boolean {
	return selection.anchor.nodeId === selection.head.nodeId && selection.anchor.offset === selection.head.offset;
}

function documentInsertionMarks(model: TextModel, selection: DocumentSelection | undefined): readonly DocumentMark[] | undefined {
	if (model.storedMarks !== undefined) return model.storedMarks;
	if (!selection || selection.kind !== "text" || !isCollapsedDocumentTextSelection(selection)) return undefined;
	const node = findNode(model.document, selection.anchor.nodeId);
	return node?.text === undefined ? undefined : node.marks;
}
