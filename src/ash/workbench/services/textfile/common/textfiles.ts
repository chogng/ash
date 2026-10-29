import type { Event } from '../../../../base/common/event.js';
import type { IFileChangeEvent } from '../../../../platform/files/common/files.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ITextFileSaveEvent, ResolvedTextFileContent, TextFileResolveRequest, TextFileSaveRequest, TextFileSaveResult } from './textFileService.js';

export const enum EncodingMode { Encode, Decode }

/** Encoding preference and byte reload belong to the shared file model. */
export interface IEncodingSupport {
	getEncoding(): string | undefined;
	setEncoding(encoding: string, mode: EncodingMode): Promise<void>;
}

/** Resource-content boundary used by text editors independently of their model implementation. */
export interface ITextFileService {
	readonly onDidChangeFiles: Event<IFileChangeEvent>;
	readonly onDidSave: Event<ITextFileSaveEvent>;
	resolve(request: TextFileResolveRequest, signal: AbortSignal): Promise<ResolvedTextFileContent>;
	/** Waits for provider settlement even after cancellation; a committed write returns its revision. */
	save(request: TextFileSaveRequest, signal: AbortSignal): Promise<TextFileSaveResult>;
}

export const ITextFileService = createServiceIdentifier<ITextFileService>('textFileService');
