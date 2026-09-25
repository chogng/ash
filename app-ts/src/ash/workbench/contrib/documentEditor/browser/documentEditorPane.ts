import { CancellationError } from '../../../../base/common/errors.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { DocumentCollaborationRoom } from '../../../services/documentCollaboration/common/documentCollaborationService.js';
import { CollaborationContribution, type CollaborationStartResult } from './collaborationContribution.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { createDefaultDocumentSchema, type DocumentSchema } from '../../../../editor/common/model/documentSchema.js';
import type { DocumentPlugin } from '../../../../editor/common/model/documentPlugin.js';
import type { TextModelWorkingCopyReference } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { assertDefined } from "../../../../base/common/types.js";
import { Disposable, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { IDimension } from "../../../../base/browser/dom.js";
import type { URI } from "../../../../base/common/uri.js";
import { RichTextEditorWidget, type RichTextEditorOptions } from "../../../../editor/browser/widget/richTextEditor/richTextEditorWidget.js";
import type { DocumentSelection } from "../../../../editor/common/core/documentSelection.js";
import type { DocumentNode } from "../../../../editor/common/model/document.js";
import type { DocumentOutline } from "../../../../editor/common/model/documentOutline.js";
import type { IDocumentCollaborationService } from '../../../services/documentCollaboration/common/documentCollaborationService.js';
import { EditorPaneVisibility, type IEditorPane } from "../../../browser/parts/editor/editorPane.js";
import type { EditorInput } from "../../../browser/parts/editor/editorInput.js";
import { DocumentEditorTextModelService } from "../../../services/documentEditor/browser/documentEditorTextModelService.js";
import type { ITextFileService } from "../../../services/textfile/common/textFileService.js";
import type { IWorkingCopy } from "../../../services/workingCopy/common/workingCopyService.js";
import type { IWorkingCopyService } from "../../../services/workingCopy/common/workingCopyService.js";
import { DOCUMENT_EDITOR_ID } from "./documentEditorInput.js";
import { h } from "../../../../base/browser/dom.js";
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';

/** Workbench-only services that complement one document editor. */
export interface EditorPaneOptions extends RichTextEditorOptions {
	readonly collaborationSchemaId?: string;
	readonly onSave?: () => Promise<void | boolean>;
	readonly plugins?: readonly DocumentPlugin<unknown>[];
	readonly schema?: DocumentSchema;
	readonly createEmptyDocument?: () => DocumentNode;
	readonly workingCopyService?: IWorkingCopyService;
	readonly createDocumentCollaborationService?: () => IDocumentCollaborationService;
}

/** Workbench pane that hosts one structured document editor. */
export class DocumentEditorPane extends Disposable implements IEditorPane {
	readonly id = DOCUMENT_EDITOR_ID;

	private readonly modelReference = this._register(new MutableDisposable<TextModelWorkingCopyReference>());
	private readonly schema: DocumentSchema;
	private inputGeneration = 0;
	private readonly modelService: DocumentEditorTextModelService;
	private readonly options: EditorPaneOptions;
	private collaborationService: IDocumentCollaborationService | undefined;
	private collaboration: CollaborationContribution | undefined;
	private room: DocumentCollaborationRoom | undefined;
	private roomRequest: AbortController | undefined;
	private readonly roomStateListener = this._register(new MutableDisposable<IDisposable>());
	private editor: RichTextEditorWidget | undefined;
	private container: HTMLDivElement | undefined;
	private dimension: IDimension = { width: 0, height: 0 };

	get workingCopy(): IWorkingCopy | undefined {
		return this.modelReference.value;
	}

	constructor(textFiles: ITextFileService, options: EditorPaneOptions = {}, @IDialogService private readonly dialogs: IDialogService) {
		super();
		this.options = options;
		this._register(toDisposable(() => this.stopCollaboration()));
		this.schema = options.schema ?? createDefaultDocumentSchema();
		this.modelService = this._register(new DocumentEditorTextModelService(textFiles, options.workingCopyService));
		this._register(toDisposable(() => {
			this.container?.remove();
			this.container = undefined;
		}));
	}

	create(parent: HTMLElement): void {
		if (this.container) throw new ReferenceError("Document editor pane has already been created");
		const container = h(parent.ownerDocument, "div");
		container.className = "stanza-structured-editor-pane";
		parent.append(container);
		this.container = container;
		const { workingCopyService: _workingCopyService, createDocumentCollaborationService, ...editorOptions } = this.options;
		this.collaborationService = createDocumentCollaborationService ? this._register(createDocumentCollaborationService()) : undefined;
		const collaboration = this._register(new CollaborationContribution(container, {
			onStart: roomId => this.startCollaboration(roomId),
			onStop: () => this.stopCollaboration(),
			onInvite: (displayName, role) => this.requireRoom().createInvite(displayName, role, this.roomRequest!.signal),
			onListMembers: () => this.requireRoom().listMembers(this.roomRequest!.signal),
			onRotateMemberAccessToken: principalId => this.requireRoom().rotateMemberAccessToken(principalId, this.roomRequest!.signal),
			onRevokeMember: principalId => this.requireRoom().revokeMember(principalId, this.roomRequest!.signal),
		}, this.dialogs));
		this.collaboration = collaboration;
		container.append(collaboration.element);
		collaboration.setState(this.collaborationService ? 'inactive' : 'unavailable');
		const editor = this._register(new RichTextEditorWidget(editorOptions, this.dialogs));
		this.editor = editor;
		editor.create(container);
	}

	async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		this.requireContainer();
		const editor = this.requireEditor();
		const generation = ++this.inputGeneration;
		const reference = await this.modelService.acquire({
			resource: input.resource,
			initialText: input.initialText,
			schema: this.schema,
			plugins: this.options.plugins,
			createEmptyDocument: this.options.createEmptyDocument,
			onSave: this.options.onSave,
		}, signal);
		if (signal.aborted || this.isDisposed || generation !== this.inputGeneration) {
			reference.dispose();
			throwIfCancelled(signal, 'Document editor input loading was cancelled');
			return;
		}
		try {
			this.stopCollaboration();
			editor.setModel(reference.model, input);
			if (this.collaboration) this.collaboration.element.hidden = false;
		} catch (error) {
			reference.dispose();
			throw error;
		}
		this.modelReference.value = reference;
		editor.layout(this.dimension);
	}

	clearInput(): void {
		this.inputGeneration += 1;
		this.stopCollaboration();
		if (this.collaboration) this.collaboration.element.hidden = true;
		this.requireEditor().clearInput();
		this.modelReference.clear();
	}

	layout(dimension: IDimension): void {
		this.dimension = { width: Math.max(0, dimension.width), height: Math.max(0, dimension.height) };
		this.requireEditor().layout(this.dimension);
	}

	setVisible(visibility: EditorPaneVisibility): void {
		if (this.container) this.container.hidden = visibility === EditorPaneVisibility.Hidden;
	}

	focus(): void {
		this.requireEditor().focus();
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
		return this.modelReference.value?.isDirty ?? false;
	}

	get hasExternalChange(): boolean {
		return this.modelReference.value?.hasExternalChange ?? false;
	}

	getDocument(): DocumentNode {
		return this.requireEditor().getDocument();
	}

	/** Returns the current structured-document selection of the hosted editor. */
	getDocumentSelection(): DocumentSelection | undefined {
		return this.requireEditor().getDocumentSelection();
	}

	getOutline(): DocumentOutline {
		return this.requireEditor().getOutline();
	}

	private async startCollaboration(roomId: string | undefined): Promise<CollaborationStartResult> {
		const service = this.collaborationService;
		if (!service) throw new Error('Document collaboration is unavailable in this renderer');
		const reference = this.requireWorkingCopy();
		this.roomRequest?.abort();
		this.roomStateListener.clear();
		this.room = undefined;
		this.requireEditor().clearCollaboration();
		const request = new AbortController();
		this.roomRequest = request;
		const room = await service.open({
			roomId,
			clientId: `stanza-${generateUuid()}`,
			schemaId: this.options.collaborationSchemaId ?? 'stanza-document-v1',
			schema: reference.model.schema,
			document: reference.model.document,
		}, request.signal);
		if (request.signal.aborted || this.isDisposed || this.modelReference.value !== reference) {
			room.dispose();
			throw new CancellationError('Opening a document collaboration room was cancelled');
		}
		try {
			const controller = this.requireEditor().setCollaborationConnection(room);
			this.room = room;
			this.roomStateListener.value = controller.onDidChangeState(change => {
				this.collaboration?.setState(change.state, { roomId: room.roomId, principalId: room.principalId, canManageMembers: room.canManageMembers, message: change.message });
			});
			return { roomId: room.roomId, principalId: room.principalId, canManageMembers: room.canManageMembers };
		} catch (error) {
			room.dispose();
			throw error;
		}
	}

	private stopCollaboration(): void {
		this.roomRequest?.abort();
		this.roomRequest = undefined;
		this.roomStateListener.clear();
		this.room = undefined;
		if (this.editor && !this.editor.isDisposed) this.editor.clearCollaboration();
		this.collaboration?.setState(this.collaborationService ? 'inactive' : 'unavailable');
	}

	private requireRoom(): DocumentCollaborationRoom {
		if (!this.room || !this.roomRequest || this.roomRequest.signal.aborted) throw new Error('Document collaboration is not connected');
		if (!this.room.canManageMembers) throw new Error('This collaboration member cannot manage room credentials');
		return this.room;
	}

	private requireWorkingCopy(): TextModelWorkingCopyReference {
		const reference = this.modelReference.value;
		assertDefined(reference, new ReferenceError('Document editor pane has no active working copy'));
		return reference;
	}

	private requireContainer(): HTMLDivElement {
		assertDefined(this.container, new ReferenceError("Document editor pane has not been created"));
		return this.container;
	}

	private requireEditor(): RichTextEditorWidget {
		const editor = this.editor;
		assertDefined(editor, new ReferenceError("Document editor pane has not been created"));
		return editor;
	}
}
