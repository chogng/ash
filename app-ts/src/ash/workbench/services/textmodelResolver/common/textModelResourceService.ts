import { createServiceIdentifier, type ServiceIdentifier } from "../../../../platform/instantiation/common/instantiation.js";
import { type Event } from "../../../../base/common/event.js";
import { type IDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import type { DocumentNode } from "../../../../editor/common/model/document.js";
import type { DocumentPlugin } from "../../../../editor/common/model/documentPlugin.js";
import type { DocumentSchema } from "../../../../editor/common/model/documentSchema.js";
import { type TextModel } from "../../../../editor/common/model/textModel.js";

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
	save(signal: AbortSignal): Promise<void>;
	revert(signal: AbortSignal): Promise<void>;
}

/** TextModel reference that also participates in Workbench backup and Save As. */
export interface TextModelWorkingCopyReference extends TextModelReference {
	readonly backupKind: "structuredDocument";
	readonly backupContentType?: string;
	readonly onDidChangeContent: Event<void>;
	backup(): string;
	restoreBackup(content: string): void;
	saveAs(resource: URI, signal: AbortSignal): Promise<void>;
}

/** Resolves resource identities to reference-counted text models and their persisted baseline. */
export interface ITextModelResourceService<TInput extends TextModelInput = TextModelInput, TReference extends TextModelReference = TextModelReference> extends IDisposable {
	acquire(input: TInput, signal: AbortSignal): Promise<TReference>;
}

/** Revalidates already open file models after a host focus change. */
export interface IFileTextModelService extends ITextModelResourceService {
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
