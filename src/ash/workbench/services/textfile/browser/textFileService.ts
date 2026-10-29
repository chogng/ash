import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IElevatedFileService } from '../../files/common/elevatedFileService.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { FileRevisionConflictError, IFileService, FileSystemProviderErrorCode, toFileSystemProviderErrorCode, type IFileChangeEvent } from '../../../../platform/files/common/files.js';
import { IFilesConfigurationService } from '../../filesConfiguration/common/filesConfigurationService.js';
import { TextFileBinaryError, TextFileContentSource, TextFileSaveConflictError, TextFileTooLargeError } from '../common/textFileService.js';
import type { ITextFileSaveEvent, ResolvedTextFileContent, TextFileResolveRequest, TextFileSaveRequest, TextFileSaveResult } from '../common/textFileService.js';
import type { ITextFileService } from '../common/textfiles.js';
import { assertEncoding } from '../common/encoding.js';

/** Resolves bootstrap snapshots first and otherwise delegates workspace reads to the file service. */
export class TextFileService extends Disposable implements ITextFileService {
	public readonly onDidChangeFiles: Event<IFileChangeEvent>;
	private readonly saved = this._register(new Emitter<ITextFileSaveEvent>());
	public readonly onDidSave = this.saved.event;

	constructor(
		@IFileService private readonly files: IFileService,
		@IFilesConfigurationService private readonly filesConfiguration: IFilesConfigurationService,
		@IElevatedFileService private readonly elevatedFiles: IElevatedFileService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		if (!files || typeof files.readFile !== 'function' || typeof files.writeFile !== 'function') {
			throw new TypeError('Text file service requires a file service');
		}
		this.onDidChangeFiles = files.onDidChangeFiles;
	}

	public async resolve(request: TextFileResolveRequest, signal: AbortSignal): Promise<ResolvedTextFileContent> {
		validateRequest(request);
		throwIfCancelled(signal, 'Text file resolution was cancelled');
		const overrides = { resource: request.resource, overrideIdentifier: request.languageId };
		const preferredEncoding = request.encoding ?? this.configuration.getValue<string>('files.encoding', overrides) ?? 'utf8';
		const decoding =
			request.encoding !== undefined
				? undefined
				: {
						autoGuessEncoding: request.autoGuessEncoding ?? this.configuration.getValue<boolean>('files.autoGuessEncoding', overrides) ?? false,
						candidateGuessEncodings: request.candidateGuessEncodings ?? this.configuration.getValue<string[]>('files.candidateGuessEncodings', overrides) ?? [],
					};
		if (request.bootstrapText !== undefined) {
			return Object.freeze({
				resource: request.resource,
				text: request.bootstrapText,
				source: TextFileContentSource.Bootstrap,
				revision: undefined,
				encoding: preferredEncoding,
			});
		}
		if (!request.readFile) {
			const stat = await raceCancellationError(this.files.stat(request.resource), signal, 'Text file resolution was cancelled');
			if (stat.sizeBytes > MAX_SAFE_TEXT_FILE_BYTES) {
				throw new TextFileTooLargeError(request.resource, stat.sizeBytes);
			}
		}
		let content;
		try {
			// The scoped reader owns both the size bound and the handle used for policy
			// validation. A separate editor stat/read would use the broader window grant.
			const read = request.readFile ? request.readFile(request.resource, preferredEncoding, decoding, signal) : this.files.readFile(request.resource, preferredEncoding, decoding);
			content = await raceCancellationError(read, signal, 'Text file resolution was cancelled');
		} catch (error) {
			if (toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.FileNotText || error instanceof TypeError)
				throw new TextFileBinaryError(request.resource, undefined, { cause: error });
			throw error;
		}
		const text = content.content;
		const encoding = content.encoding ?? preferredEncoding;
		throwIfCancelled(signal, 'Text file resolution was cancelled');
		if (looksBinary(text)) throw new TextFileBinaryError(request.resource);
		return Object.freeze({
			resource: request.resource,
			text,
			source: TextFileContentSource.FileSystem,
			revision: content.revision,
			encoding,
		});
	}

	public async save(request: TextFileSaveRequest, signal: AbortSignal): Promise<TextFileSaveResult> {
		validateSaveRequest(request);
		throwIfCancelled(signal, 'Text file save was cancelled');
		const readonly = this.filesConfiguration.isReadonly(request.resource);
		if (readonly) {
			throw new Error(typeof readonly === 'string' ? readonly : localize('files.readonly', 'This file is read-only.'));
		}
		try {
			const content = request.text;
			if (request.writeElevated && !this.elevatedFiles.isSupported(request.resource))
				throw new Error(localize('files.elevationUnavailable', 'System authorization is unavailable on this host.'));
			// Join the provider write before cancellation can release a transaction for rollback.
			const saved = await this.files.writeFile(
				{
					resource: request.resource,
					content,
					encoding: request.encoding ?? 'utf8',
					...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
				},
				{
					create: !request.unlock,
					overwrite: true,
					...(request.unlock ? { unlock: true } : {}),
					...(request.writeElevated ? { writeElevated: true } : {}),
				},
				signal,
			);
			this.saved.fire({
				resource: request.resource,
				content: request.encoding === 'utf8bom' ? '\uFEFF' + content : content,
				revision: saved.revision,
			});
			return Object.freeze({ revision: saved.revision });
		} catch (error) {
			if (error instanceof FileRevisionConflictError) {
				throw new TextFileSaveConflictError(request.resource);
			}
			throw error;
		}
	}
}

const MAX_SAFE_TEXT_FILE_BYTES = 32 * 1024 * 1024;

function looksBinary(text: string): boolean {
	const sampleLength = Math.min(text.length, 8_192);
	if (sampleLength === 0) {
		return false;
	}
	let suspicious = 0;
	for (let index = 0; index < sampleLength; index += 1) {
		const byte = text.charCodeAt(index);
		if (byte === 0) {
			return true;
		}
		if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
			suspicious += 1;
		}
	}
	return suspicious / sampleLength > 0.1;
}

function validateRequest(request: TextFileResolveRequest): void {
	if (!request || typeof request !== 'object' || !request.resource || typeof request.resource.toString !== 'function') {
		throw new TypeError('Text file resolution requires a resource');
	}
	if (request.bootstrapText !== undefined && typeof request.bootstrapText !== 'string') {
		throw new TypeError('Text file bootstrap content must be text');
	}
	if (request.encoding !== undefined) assertEncoding(request.encoding);
	if ('autoGuessEncoding' in request && request.autoGuessEncoding !== undefined && typeof request.autoGuessEncoding !== 'boolean')
		throw new TypeError(localize('files.invalidAutoGuessEncoding', 'Automatic encoding detection must be true or false.'));
	if ('candidateGuessEncodings' in request && request.candidateGuessEncodings !== undefined) {
		if (!Array.isArray(request.candidateGuessEncodings) || request.candidateGuessEncodings.length > 50)
			throw new TypeError(localize('files.invalidCandidateGuessEncodings', 'Enter a list of unique detectable encoding identifiers.'));
		for (const encoding of request.candidateGuessEncodings) assertEncoding(encoding);
	}
}

function validateSaveRequest(request: TextFileSaveRequest): void {
	if (!request || typeof request !== 'object' || !request.resource || typeof request.resource.toString !== 'function') {
		throw new TypeError('Text file save requires a resource');
	}
	if (typeof request.text !== 'string') {
		throw new TypeError('Text file save content must be text');
	}
	if (request.expectedRevision !== undefined && typeof request.expectedRevision !== 'string') {
		throw new TypeError('Text file expected revision must be text');
	}
	if (request.encoding !== undefined) assertEncoding(request.encoding);
}
