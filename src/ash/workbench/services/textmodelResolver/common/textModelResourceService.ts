import { createServiceIdentifier, type ServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import { type Event } from "../../../../base/common/event.js";
import { type IDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import type { DocumentNode } from "../../../../editor/common/model/document.js";
import type { DocumentPlugin } from "../../../../editor/common/model/documentPlugin.js";
import type { DocumentSchema } from "../../../../editor/common/model/documentSchema.js";
import { type TextModel } from "../../../../editor/common/model/textModel.js";
import type { ISaveOptions, SaveReason } from '../../../common/editor.js';

/** Runs against the shared model before the persistence owner captures the text to write. */
export interface ITextModelSaveParticipant {
	participate(model: TextModel, reason: SaveReason, signal: AbortSignal): Promise<void>;
}

/** Completes recovery bookkeeping after the file has accepted this text. */
export type TextModelSaveCompletion = (savedText: string) => Promise<void>;

/** Reports an acknowledged snapshot, independently of file dirty state and discard success. */
export interface TextModelSaveRecoveryContext {
	readonly retry: boolean;
	acknowledge(modelVersion: number): void;
}

/** Prepares durable recovery content after editing participants and before file publication. */
export interface ITextModelSaveCompletionParticipant {
	prepare(model: TextModel, signal: AbortSignal, recovery: TextModelSaveRecoveryContext): Promise<TextModelSaveCompletion | undefined>;
}

/** The minimum identity and bootstrap data needed to acquire a text model. */
export interface TextModelInput {
	readonly resource: URI;
	readonly initialText?: string;
	readonly languageId?: string;
	readonly contentType?: string;
}

/** Schema and block configuration used when a document profile opens a TextModel. */
export interface TextModelBlockInput extends TextModelInput {
	readonly schema: DocumentSchema;
	readonly plugins?: readonly DocumentPlugin<unknown>[];
	readonly createEmptyDocument?: () => DocumentNode;
	readonly onSave?: () => Promise<void | boolean>;
}

/** A reference-counted text model plus its persisted-file state. */
export interface TextModelReference extends IDisposable {
	readonly resource: URI;
	readonly model: TextModel;
	readonly isDirty: boolean;
	readonly onDidChangeDirty: Event<void>;
	readonly hasExternalChange: boolean;
	readonly onDidChangeExternalChange: Event<void>;
	save(signal: AbortSignal, options?: ISaveOptions): Promise<void>;
	saveAs(resource: URI, signal: AbortSignal): Promise<void>;
	revert(signal: AbortSignal): Promise<void>;
}

/** TextModel reference that also participates in Workbench backup and Save As. */
export interface TextModelWorkingCopyReference extends TextModelReference {
	readonly backupKind: "structuredDocument";
	readonly backupContentType?: string;
	readonly onDidChangeContent: Event<void>;
	backup(): string;
	restoreBackup(content: string): void;
}

/** Resolves resource identities to reference-counted text models and their persisted baseline. */
export interface ITextModelResourceService<TInput extends TextModelInput = TextModelInput, TReference extends TextModelReference = TextModelReference> extends IDisposable {
	acquire(input: TInput, signal: AbortSignal): Promise<TReference>;
}

/** Shared open file models and their resource and language lifecycle. */
export interface IFileTextModelService extends ITextModelResourceService {
	addSaveParticipant(participant: ITextModelSaveParticipant): IDisposable;
	addSaveCompletionParticipant(participant: ITextModelSaveCompletionParticipant): IDisposable;
	/** Includes queued saves and failed necessary checkpoints, without changing file dirty state. */
	hasPendingSaveRecovery(resource?: URI): boolean;
	/** Waits for this URI and rejects its unresolved recovery error until an explicit retry succeeds. */
	waitForSaveRecovery(resource?: URI): Promise<void>;
	readonly onModelAdded: Event<TextModel>;
	readonly onModelRemoved: Event<TextModel>;
	readonly onModelLanguageChanged: Event<{ readonly model: TextModel; readonly oldLanguageId: string; }>;
	getModel(resource: URI): TextModel | null;
	getModels(): readonly TextModel[];
	/** Revalidates an open file after the host regains focus. */
	refresh(resource: URI): Promise<void>;
}

export const IFileTextModelService: ServiceIdentifier<IFileTextModelService> = createServiceIdentifier<IFileTextModelService>('fileTextModelService');

export type { ITextResourceStore } from "./textResourceStore.js";

/** Service key used by hosts that register a text model service. */
export const ITextModelResourceService: ServiceIdentifier<ITextModelResourceService> = createServiceIdentifier<ITextModelResourceService>("textModelResourceService");

/** Reports that a resource changed after the model established its saved baseline. */
export class TextModelConflictError extends Error {
	constructor(readonly resource: URI) {
		super(`Cannot save '${resource.toString()}' because it changed outside the editor`);
		this.name = "TextModelConflictError";
	}
}

/** The file and its revision were saved; only recovery bookkeeping needs retrying. */
export class TextModelSaveCompletionError extends Error {
	public readonly fileSaved = true;

	constructor(public readonly resource: URI, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = 'TextModelSaveCompletionError';
	}
}
