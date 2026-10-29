import type { IEditorExtensionApi } from '../../../common/editor.js';
import type {
	DocumentEditorConfiguration,
	DocumentEditorWidget,
} from '../../../services/documentEditor/browser/documentEditorProfile.js';
import type { DocumentCodec, DocumentTextFormat } from '../../../services/documentEditor/common/documentCodec.js';
import { IChannelService, type ChannelReference } from '../../../../platform/collab/common/channelService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { DocumentCollaborationRoom } from '../../../services/documentCollaboration/common/documentCollaborationService.js';
import { CollaborationContribution, type CollaborationStartResult } from './collaborationContribution.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import type { TextModelWorkingCopyReference } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { assertDefined } from '../../../../base/common/types.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IDimension } from '../../../../base/browser/dom.js';
import type { URI } from '../../../../base/common/uri.js';
import type { DocumentSelection } from '../../../services/documentEditor/common/documentCodec.js';
import type { DocumentNode } from '../../../services/documentEditor/common/documentCodec.js';
import type { DocumentOutline } from '../../../services/documentEditor/common/documentCodec.js';
import type { IDocumentCollaborationService } from '../../../services/documentCollaboration/common/documentCollaborationService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IDocumentEditorTextModelService } from '../../../services/documentEditor/common/documentTypes.js';
import type { IWorkingCopy } from '../../../services/workingCopy/common/workingCopyService.js';
import { DOCUMENT_EDITOR_ID } from './documentEditorInput.js';
import { h } from '../../../../base/browser/dom.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { CallDocument } from '../../../../platform/call/common/callService.js';
import { localize } from '../../../../nls.js';

/** Workbench-only services that complement one document editor. */
export interface EditorPaneOptions extends Pick<
	DocumentEditorConfiguration,
	'codec' | 'widget' | 'exportText' | 'createEmptyDocument' | 'importBinary' | 'artifactFormats' | 'accessibilityHelp'
> {
	readonly codec: DocumentCodec;
	readonly modelCompatibility?: string;
	readonly editorId?: string;
	/** Retiring a capability freezes the view without closing its dirty working copy. */
	readonly providerSignal?: AbortSignal;
	readonly contentType: string;
	readonly collaborationSchemaId?: string;
	readonly onSave?: () => Promise<void | boolean>;
	readonly createEmptyDocument?: () => DocumentNode;
	readonly createDocumentCollaborationService?: () => IDocumentCollaborationService;
}

/** Workbench pane that hosts one structured document editor. */
export class DocumentEditorPane extends EditorPane implements IEditorPane {
	readonly id: string;

	private readonly modelReference = this._register(new MutableDisposable<TextModelWorkingCopyReference>());
	private inputGeneration = 0;
	private artifactLifetime = new AbortController();
	private readonly options: EditorPaneOptions;
	private collaborationService: IDocumentCollaborationService | undefined;
	private collaboration: CollaborationContribution | undefined;
	private room: DocumentCollaborationRoom | undefined;
	private channel: ChannelReference | undefined;
	private roomRequest: AbortController | undefined;
	private readonly roomStateListener = this._register(new MutableDisposable<IDisposable>());
	private editor: DocumentEditorWidget | undefined;
	private container: HTMLDivElement | undefined;
	private dimension: IDimension = { width: 0, height: 0 };

	get workingCopy(): IWorkingCopy | undefined {
		return this.modelReference.value;
	}

	constructor(
		options: EditorPaneOptions,
		@IDialogService private readonly dialogs: IDialogService,
		@IDocumentEditorTextModelService private readonly modelService: IDocumentEditorTextModelService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(options.editorId ?? DOCUMENT_EDITOR_ID, themeService, storageService);
		this.id = options.editorId ?? DOCUMENT_EDITOR_ID;
		this.options = options;
		const retire = () => {
			this.artifactLifetime.abort();
			this.stopCollaboration();
			this.editor?.setReadOnly(true);
		};
		options.providerSignal?.addEventListener('abort', retire, { once: true });
		this._register(toDisposable(() => options.providerSignal?.removeEventListener('abort', retire)));
		this._register(
			toDisposable(() => {
				this.artifactLifetime.abort();
				this.stopCollaboration();
			}),
		);
		this._register(
			toDisposable(() => {
				this.container?.remove();
				this.container = undefined;
			}),
		);
	}

	public getArtifactFormats(): NonNullable<DocumentEditorConfiguration['artifactFormats']> {
		return this.options.artifactFormats ?? [];
	}

	public exportArtifact(format: string, signal: AbortSignal): Promise<Uint8Array> {
		this.options.providerSignal?.throwIfAborted();
		if (!this.editor?.exportArtifact || !this.getArtifactFormats().some(candidate => candidate.id === format))
			throw new Error(
				localize('document.output.unavailable', 'This document provider does not support the selected output.'),
			);
		return this.editor.exportArtifact(
			format,
			AbortSignal.any([
				signal,
				this.artifactLifetime.signal,
				...(this.options.providerSignal ? [this.options.providerSignal] : []),
			]),
		);
	}

	public exportText(format: DocumentTextFormat): string {
		return this.options.exportText(this.getDocument(), format);
	}

	public getAccessibleContent(): string {
		return this.editor?.getAccessibleContent?.() ?? this.options.codec.toPlainText(this.getDocument());
	}

	public getAccessibilityHelp(): readonly string[] {
		return this.options.accessibilityHelp?.() ?? [];
	}

	/** A conversion populates the already-open untitled working copy without acquiring a second model. */
	public restoreDraft(document: DocumentNode): void {
		const reference = this.requireWorkingCopy();
		if (reference.resource.scheme !== 'untitled')
			throw new Error('Only an untitled document accepts a converted draft');
		reference.restoreBackup(this.options.codec.serialize(document));
	}

	public override create(parent: HTMLElement): void {
		if (this.container) throw new ReferenceError('Document editor pane has already been created');
		const container = h(parent.ownerDocument, 'div');
		container.className = 'stanza-structured-editor-pane';
		parent.append(container);
		super.create(container);
		this.container = container;
		const { createDocumentCollaborationService } = this.options;
		this.collaborationService = createDocumentCollaborationService
			? this._register(createDocumentCollaborationService())
			: undefined;
		const collaboration = this._register(
			new CollaborationContribution(
				container,
				{
					fixedRoom: () => (this.channel ? `channel-notes-${this.channel.channelId}` : undefined),
					onStart: roomId => this.startCollaboration(roomId, this.channel?.serverUrl, this.channel),
					onStop: () => this.stopCollaboration(),
					onInvite: (displayName, role) =>
						this.requireRoom().createInvite(displayName, role, this.roomRequest!.signal),
					onListMembers: () => this.requireRoom().listMembers(this.roomRequest!.signal),
					onRotateMemberAccessToken: principalId =>
						this.requireRoom().rotateMemberAccessToken(principalId, this.roomRequest!.signal),
					onRevokeMember: principalId =>
						this.requireRoom().revokeMember(principalId, this.roomRequest!.signal),
				},
				this.dialogs,
			),
		);
		this.collaboration = collaboration;
		container.append(collaboration.element);
		collaboration.setState(this.collaborationService ? 'inactive' : 'unavailable');
		const editor = this._register(this.instantiation.createInstance(this.options.widget));
		this.editor = editor;
		editor.create(container);
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.requireContainer();
		this.options.providerSignal?.throwIfAborted();
		const editor = this.requireEditor();
		const generation = ++this.inputGeneration;
		this.artifactLifetime.abort();
		this.artifactLifetime = new AbortController();
		const reference = await this.modelService.acquire(
			{
				resource: input.resource,
				contentType: this.options.contentType,
				initialText: input.initialText,
				codec: this.options.codec,
				modelCompatibility: this.options.modelCompatibility,
				createEmptyDocument: this.options.createEmptyDocument,
				onSave: this.options.onSave,
			},
			signal,
		);
		if (
			signal.aborted ||
			this.options.providerSignal?.aborted ||
			this.isDisposed ||
			generation !== this.inputGeneration
		) {
			reference.dispose();
			throwIfCancelled(signal, 'Document editor input loading was cancelled');
			this.options.providerSignal?.throwIfAborted();
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
		this.channel = undefined;
		this.modelReference.value = reference;
		editor.layout(this.dimension);
	}

	public override clearInput(): void {
		this.inputGeneration += 1;
		this.artifactLifetime.abort();
		this.stopCollaboration();
		if (this.collaboration) this.collaboration.element.hidden = true;
		this.requireEditor().clearInput();
		this.modelReference.clear();
	}

	public override layout(dimension: IDimension): void {
		this.dimension = { width: Math.max(0, dimension.width), height: Math.max(0, dimension.height) };
		this.requireEditor().layout(this.dimension);
	}

	public override focus(): void {
		this.requireEditor().focus();
	}

	getExtensionApi(id: string): IEditorExtensionApi | undefined {
		const api = this.editor?.getExtensionApi?.(id);
		if (!api || this.isDisposed || this.options.providerSignal?.aborted) return undefined;
		const lifetime = this.artifactLifetime.signal;
		return {
			version: api.version,
			readOnly: api.readOnly,
			invoke: async (payload, signal) => {
				const request = AbortSignal.any([
					signal,
					lifetime,
					...(this.options.providerSignal ? [this.options.providerSignal] : []),
				]);
				request.throwIfAborted();
				return api.invoke(payload, request);
			},
		};
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

	getCollaborationDocument(): CallDocument | undefined {
		if (!this.room?.serverUrl || !this.roomRequest || this.roomRequest.signal.aborted) return undefined;
		const resource = this.requireWorkingCopy().resource;
		return {
			serverUrl: this.room.serverUrl,
			roomId: this.room.roomId,
			schemaId: this.options.collaborationSchemaId ?? 'stanza-document-v1',
			contentType: this.options.contentType,
			title: resource.path.split('/').pop() || localize('call.document.untitled', 'Untitled document'),
		};
	}

	async joinCollaborationDocument(document: CallDocument, channel?: ChannelReference): Promise<void> {
		if (
			document.schemaId !== (this.options.collaborationSchemaId ?? 'stanza-document-v1') ||
			document.contentType !== this.options.contentType
		) {
			throw new Error(
				localize('call.document.incompatible', 'This editor cannot open the shared document format.'),
			);
		}
		if (
			this.room?.roomId === document.roomId &&
			this.room.serverUrl === document.serverUrl &&
			!this.roomRequest?.signal.aborted
		)
			return;
		const reference = this.requireWorkingCopy();
		if (reference.resource.scheme !== 'untitled' || reference.isDirty) {
			throw new Error(
				localize(
					'call.document.newCopyRequired',
					'Open shared documents in a new untitled editor to preserve local changes.',
				),
			);
		}
		this.channel = channel;
		const opened = await this.startCollaboration(document.roomId, document.serverUrl, channel);
		this.collaboration?.setState('connected', opened);
	}

	private async startCollaboration(
		roomId: string | undefined,
		serverUrl?: string,
		channel?: ChannelReference,
	): Promise<CollaborationStartResult> {
		const service = this.collaborationService;
		if (!service) throw new Error('Document collaboration is unavailable in this renderer');
		const reference = this.requireWorkingCopy();
		const channels = channel
			? this.instantiation.invokeFunction(accessor => accessor.getOptional(IChannelService))
			: undefined;
		const memberId = channels?.space?.memberId;
		const role = channels?.space?.members.find(member => member.id === memberId)?.role;
		const authorized = () =>
			!channel ||
			(!!channels?.space &&
				channels.space.id === channel.spaceId &&
				channels.space.serverUrl === channel.serverUrl &&
				channels.space.memberId === memberId &&
				channels.space.channels.some(entry => entry.id === channel.channelId) &&
				channels.space.members.some(member => member.id === memberId && member.role === role));
		this.roomRequest?.abort();
		this.roomStateListener.clear();
		this.room = undefined;
		this.requireEditor().clearCollaboration();
		const request = new AbortController();
		this.roomRequest = request;
		const room = await service.open(
			{
				roomId,
				channel,
				...(serverUrl === undefined ? {} : { serverUrl }),
				clientId: `stanza-${generateUuid()}`,
				schemaId: this.options.collaborationSchemaId ?? 'stanza-document-v1',
				codec: this.options.codec,
				document: reference.model.document,
			},
			request.signal,
		);
		if (request.signal.aborted || this.isDisposed || this.modelReference.value !== reference || !authorized()) {
			room.dispose();
			throw new CancellationError('Opening a document collaboration room was cancelled');
		}
		// A remote open can outlive the dialog. Preserve typing that arrived while it was pending.
		if (serverUrl !== undefined && reference.isDirty) {
			request.abort();
			room.dispose();
			throw new Error(
				localize(
					'call.document.newCopyRequired',
					'Open shared documents in a new untitled editor to preserve local changes.',
				),
			);
		}
		try {
			const controller = this.requireEditor().setCollaborationConnection(room);
			this.room = room;
			const listeners = new DisposableStore();
			this.roomStateListener.value = listeners;
			listeners.add(
				controller.onDidChangeState(change => {
					this.collaboration?.setState(change.state, {
						roomId: room.roomId,
						principalId: room.principalId,
						canManageMembers: room.canManageMembers,
						message: change.message,
					});
					if (channel && change.state === 'error') {
						request.abort();
						listeners.clear();
					}
				}),
			);
			if (channel && channels) {
				listeners.add(channels.watch());
				listeners.add(
					channels.onDidChange(() => {
						if (!request.signal.aborted && !authorized()) {
							request.abort();
							controller.invalidate(
								localize(
									'collaboration.permissionChanged',
									'Channel access changed. Reopen the notes to apply current permissions; unsynced edits are preserved in this editor.',
								),
							);
						}
					}),
				);
				this.modelService.acceptCollaborationSnapshot(reference.resource, room.initialSnapshot.document);
				listeners.add(
					controller.onDidConfirmDocument(document =>
						this.modelService.acceptCollaborationSnapshot(reference.resource, document),
					),
				);
			}
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
		if (!this.room || !this.roomRequest || this.roomRequest.signal.aborted)
			throw new Error('Document collaboration is not connected');
		if (!this.room.canManageMembers) throw new Error('This collaboration member cannot manage room credentials');
		return this.room;
	}

	private requireWorkingCopy(): TextModelWorkingCopyReference {
		const reference = this.modelReference.value;
		assertDefined(reference, new ReferenceError('Document editor pane has no active working copy'));
		return reference;
	}

	private requireContainer(): HTMLDivElement {
		assertDefined(this.container, new ReferenceError('Document editor pane has not been created'));
		return this.container;
	}

	private requireEditor(): DocumentEditorWidget {
		const editor = this.editor;
		assertDefined(editor, new ReferenceError('Document editor pane has not been created'));
		return editor;
	}
}
