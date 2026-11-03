import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr, RawContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { FileKind, FileNotFoundError, FileOperationNotSupportedError, FileRevisionConflictError, FileSystemProviderCapabilities, FileSystemProviderError, FileSystemProviderErrorCode, IFileService, type FileExistingTargetBehavior, type IFileChangeEvent, type IFileStat, type IFileSystemProvider, type IFileWriteOptions } from '../../../../../platform/files/common/files.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVoiceCodeTranscriptionBackendService, SpeechInstructionsConflictError, type SpeechInstructionKind, type SpeechInstructionsDocument } from '../../../../../platform/dictation/common/dictation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../../services/workingCopy/common/workingCopyService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { CHAT_CATEGORY } from './chatActions.js';

export const CONFIGURE_VOICE_INSTRUCTIONS_ACTION_ID = 'workbench.action.chat.configureVoiceInstructions';
export const CONFIGURE_DICTATION_INSTRUCTIONS_ACTION_ID = 'workbench.action.chat.configureDictationInstructions';
const scheme = 'ash-speech-instructions';
const available = new RawContextKey<boolean>('chat.speechInstructionsAvailable', false);
const encoder = new TextEncoder();

/** The ordinary file editor owns dirty text; this provider holds no persisted copy. */
class SpeechInstructionsContribution extends Disposable implements IFileSystemProvider {
	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.PathCaseSensitive;
	readonly onDidChangeCapabilities = Event.None;
	private readonly changes = this._register(new Emitter<IFileChangeEvent>());
	readonly onDidChangeFiles = this.changes.event;
	private readonly watches = this._register(new DisposableMap<object, DisposableStore>());
	private readonly editorWatches = this._register(new DisposableMap<IWorkingCopy>());
	private disposed = false;

	constructor(
		@IFileService files: IFileService,
		@IVoiceCodeTranscriptionBackendService private readonly backend: IVoiceCodeTranscriptionBackendService | undefined,
		@IContextKeyService context: IContextKeyService,
		@IWorkingCopyService workingCopies: IWorkingCopyService,
	) {
		super();
		const key = available.bindTo(context);
		this._register(toDisposable(() => key.reset()));
		const update = () => key.set(!!backend?.isConnected);
		update();
		if (backend) {
			this._register(backend.onDidChangeConnection(update));
			this._register(files.registerProvider(scheme, this));
			// Markdown and plain text editors share the existing working-copy registry.
			const track = (copy: IWorkingCopy) => {
				if (copy.resource.scheme === scheme) this.editorWatches.set(copy, files.watch(copy.resource));
			};
			this._register(workingCopies.onDidRegister(track));
			this._register(workingCopies.onDidUnregister(copy => this.editorWatches.deleteAndDispose(copy)));
			workingCopies.getAll().forEach(track);
		}
	}

	private kind(resource: URI): SpeechInstructionKind {
		if (resource.scheme === scheme && !resource.authority && !resource.query && !resource.fragment) {
			if (resource.path === '/voice.md') return 'voice';
			if (resource.path === '/dictation.md') return 'dictation';
		}
		throw new FileNotFoundError(resource);
	}

	private async read(resource: URI): Promise<SpeechInstructionsDocument> {
		const kind = this.kind(resource);
		if (this.disposed || !this.backend?.isConnected) throw new FileSystemProviderError(localize('chat.speechInstructions.unavailable', 'The speech backend is disconnected.'), FileSystemProviderErrorCode.Unavailable);
		return this.backend.readInstructions(kind);
	}

	private metadata(resource: URI, text: string): IFileStat {
		return { resource, kind: FileKind.File, sizeBytes: encoder.encode(text).length, readonly: false, modifiedAtMillis: undefined };
	}

	async stat(resource: URI): Promise<IFileStat> {
		const document = await this.read(resource);
		if (!document.exists) throw new FileNotFoundError(resource);
		return this.metadata(resource, document.text);
	}

	async readFile(resource: URI) {
		const document = await this.read(resource);
		if (!document.exists) throw new FileNotFoundError(resource);
		return { resource, bytes: encoder.encode(document.text), revision: document.revision };
	}

	async writeFile(resource: URI, content: Uint8Array, options: IFileWriteOptions, signal?: AbortSignal) {
		signal?.throwIfAborted();
		let text: string;
		try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content); }
		catch { throw new FileSystemProviderError(localize('chat.speechInstructions.utf8', 'Speech instructions must be UTF-8 Markdown.'), FileSystemProviderErrorCode.FileNotText); }
		if (content.length > 64 * 1024) throw new FileSystemProviderError(localize('chat.speechInstructions.size', 'Speech instructions must be at most 64 KiB.'), FileSystemProviderErrorCode.FileTooLarge);
		const current = await this.read(resource);
		if (!current.exists && !options.create) throw new FileNotFoundError(resource);
		if (current.exists && !options.overwrite) throw new FileSystemProviderError(localize('chat.speechInstructions.exists', 'The instructions file already exists.'), FileSystemProviderErrorCode.FileExists);
		if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) throw new FileRevisionConflictError(resource);
		signal?.throwIfAborted();
		try {
			const revision = await this.backend!.writeInstructions(this.kind(resource), text, current.revision);
			if (!this.disposed) this.changes.fire({ resources: [resource] });
			return { stat: this.metadata(resource, text), revision };
		} catch (error) {
			if (error instanceof SpeechInstructionsConflictError) throw new FileRevisionConflictError(resource);
			throw error;
		}
	}

	async createFile(resource: URI, existing: FileExistingTargetBehavior): Promise<IFileStat> {
		const current = await this.read(resource);
		if (current.exists && existing === 'ignore') return this.metadata(resource, current.text);
		try {
			return (await this.writeFile(resource, new Uint8Array(), { create: true, overwrite: existing === 'overwrite', expectedRevision: current.revision })).stat;
		} catch (error) {
			// Another window may have created the same Profile resource while opening it.
			if (existing === 'ignore' && (error instanceof FileRevisionConflictError || error instanceof FileSystemProviderError && error.code === FileSystemProviderErrorCode.FileExists)) return this.stat(resource);
			throw error;
		}
	}

	watch(resource: URI): IDisposable {
		this.kind(resource);
		const id = {};
		const scope = new DisposableStore();
		let stopped = false;
		let revision: string | undefined;
		scope.add(toDisposable(() => { stopped = true; }));
		const scheduler = scope.add(new RunOnceScheduler(() => { void poll(); }, 2000));
		const poll = async () => {
			try {
				const current = await this.read(resource);
				if (stopped) return;
				if (revision !== undefined && revision !== current.revision) this.changes.fire({ resources: [resource] });
				revision = current.revision;
			} catch { /* Retain the last revision across a temporary disconnect. */ }
			finally { if (!stopped) scheduler.schedule(); }
		};
		this.watches.set(id, scope);
		void poll();
		return toDisposable(() => this.watches.deleteAndDispose(id));
	}

	async readDirectory(resource: URI): Promise<never> { throw new FileOperationNotSupportedError(resource, 'readDirectory'); }
	async createDirectory(resource: URI): Promise<never> { throw new FileOperationNotSupportedError(resource, 'createDirectory'); }
	async copy(resource: URI): Promise<never> { throw new FileOperationNotSupportedError(resource, 'copy'); }
	async rename(resource: URI): Promise<never> { throw new FileOperationNotSupportedError(resource, 'rename'); }
	async delete(resource: URI): Promise<never> { throw new FileOperationNotSupportedError(resource, 'delete'); }
	override dispose(): void { this.disposed = true; super.dispose(); }
}

export function registerConfigureSpeechInstructionsActions(): void {
	registerWorkbenchContribution('workbench.contrib.chatSpeechInstructions', WorkbenchPhase.BlockStartup, accessor => accessor.get(IInstantiationService).createInstance(SpeechInstructionsContribution));
	for (const kind of ['voice', 'dictation'] as const) {
		registerAction2(class extends Action2 {
			constructor() {
				super({
					id: kind === 'voice' ? CONFIGURE_VOICE_INSTRUCTIONS_ACTION_ID : CONFIGURE_DICTATION_INSTRUCTIONS_ACTION_ID,
					title: kind === 'voice' ? localize2('chat.speechInstructions.voice', 'Configure Voice Mode Instructions...') : localize2('chat.speechInstructions.dictation', 'Configure Dictation Instructions...'),
					category: CHAT_CATEGORY, f1: true,
					precondition: ContextKeyExpr.and(ChatContextKeys.enabled.isEqualTo(true), available.isEqualTo(true)),
				});
			}
			override async run(accessor: ServicesAccessor): Promise<void> {
				if (accessor.get(IConfigurationService).getValue<boolean>(ChatAIDisabledSettingId) || !accessor.get(IVoiceCodeTranscriptionBackendService)?.isConnected) return;
				const files = accessor.get(IFileService);
				const editor = accessor.get(IEditorService);
				const resource = URI.from({ scheme, path: `/${kind}.md` });
				await files.createFile(resource, 'ignore');
				await editor.openEditor({ resource }, { pinned: true });
			}
		});
	}
}
