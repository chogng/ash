import { VSBuffer } from '../../../../base/common/buffer.js';
import { IElevatedFileService } from '../../files/common/elevatedFileService.js';
import { raceCancellationError } from '../../../../base/common/async.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileRevisionConflictError, IFileService, type IFileChangeEvent } from '../../../../platform/files/common/files.js';
import { IFilesConfigurationService } from '../../filesConfiguration/common/filesConfigurationService.js';
import { TextFileBinaryError, TextFileContentSource, TextFileSaveConflictError, TextFileTooLargeError } from '../common/textFileService.js';
import type { ITextFileSaveEvent, ResolvedTextFileContent, TextFileResolveRequest, TextFileSaveRequest, TextFileSaveResult } from '../common/textFileService.js';
import type { ITextFileService } from '../common/textfiles.js';

/** Resolves bootstrap snapshots first and otherwise delegates workspace reads to the file service. */
export class TextFileService extends Disposable implements ITextFileService {
	public readonly onDidChangeFiles: Event<IFileChangeEvent>;
	private readonly saved = this._register(new Emitter<ITextFileSaveEvent>());
	public readonly onDidSave = this.saved.event;

	constructor(@IFileService private readonly files: IFileService, @IFilesConfigurationService private readonly filesConfiguration: IFilesConfigurationService, @IElevatedFileService private readonly elevatedFiles: IElevatedFileService) {
		super();
		if (!files || typeof files.readFile !== 'function' || typeof files.writeFile !== 'function') {
			throw new TypeError('Text file service requires a file service');
		}
		this.onDidChangeFiles = files.onDidChangeFiles;
	}

	public async resolve(request: TextFileResolveRequest, signal: AbortSignal): Promise<ResolvedTextFileContent> {
		validateRequest(request);
		throwIfCancelled(signal, 'Text file resolution was cancelled');
		if (request.bootstrapText !== undefined) {
			return Object.freeze({
				resource: request.resource,
				text: request.bootstrapText,
				source: TextFileContentSource.Bootstrap,
				revision: undefined,
				encoding: 'utf8',
			});
		}
		const stat = await raceCancellationError(this.files.stat(request.resource), signal, 'Text file resolution was cancelled');
		if (stat.sizeBytes > MAX_SAFE_TEXT_FILE_BYTES) {
			throw new TextFileTooLargeError(request.resource, stat.sizeBytes);
		}
		const content = await raceCancellationError(this.files.readFileBytes(request.resource), signal, 'Text file resolution was cancelled');
		if (!(content.bytes instanceof Uint8Array) || typeof content.revision !== 'string') {
			throw new TypeError('File service returned invalid text content');
		}
		return Object.freeze({
			resource: request.resource,
			text: decodeUtf8Text(content.bytes, request.resource),
			source: TextFileContentSource.FileSystem,
			revision: content.revision,
			encoding: content.bytes[0] === 0xef && content.bytes[1] === 0xbb && content.bytes[2] === 0xbf ? 'utf8bom' : 'utf8',
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
			const content = request.encoding === 'utf8bom' ? '\uFEFF' + request.text : request.text;
			const saved = request.writeElevated
				? await this.elevatedFiles.writeFileElevated(request.resource, VSBuffer.fromString(content), { create: true, overwrite: true, expectedRevision: request.expectedRevision }, signal)
				: request.unlock
					? await this.files.writeFileBytes(request.resource, VSBuffer.fromString(content).buffer, { create: false, overwrite: true, expectedRevision: request.expectedRevision, unlock: true }, signal)
					: await raceCancellationError(this.files.writeFile({
						resource: request.resource,
						content,
						...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
					}), signal, 'Text file save was cancelled');
			this.saved.fire({ resource: request.resource, content, revision: saved.revision });
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

function decodeUtf8Text(bytes: Uint8Array, resource: URI): string {
	if (looksBinary(bytes)) {
		throw new TextFileBinaryError(resource);
	}
	try {
		const offset = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset));
	} catch (error) {
		throw new TextFileBinaryError(resource, 'The file is not valid UTF-8 text', { cause: error });
	}
}

function looksBinary(bytes: Uint8Array): boolean {
	const sampleLength = Math.min(bytes.length, 8_192);
	if (sampleLength === 0) {
		return false;
	}
	let suspicious = 0;
	for (let index = 0; index < sampleLength; index += 1) {
		const byte = bytes[index]!;
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
}
