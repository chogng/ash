import { decodeBase64, encodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { createUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import type { IResourceApi } from '../../agentHost/common/appServerApi.js';
import type { IFileReadSnapshot } from '../../files/common/files.js';
import type { IPdfDocument, IPdfService, PdfAnnotationEdit, PdfPage } from '../common/pdfService.js';

/** Generated transport values stay at this adapter; viewers consume only PDF domain values. */
export class AppServerPdfService implements IPdfService {
	constructor(private readonly connection: AppServerProtocolClient, private readonly resource?: IResourceApi) { }

	public async openSnapshot(acquire: (owner: IResourceApi) => Promise<IFileReadSnapshot | undefined>, signal: AbortSignal): Promise<{ document: IPdfDocument; revision: string; } | undefined> {
		signal.throwIfAborted();
		if (!this.resource || this.connection.capabilities?.contracts.pdfResource?.version !== 1) { return undefined; }
		const snapshot = await acquire(this.resource);
		if (!snapshot) { return undefined; }
		const id = createUuid();
		const document = new AppServerPdfDocument(this.connection, id);
		try {
			signal.throwIfAborted();
			const { opened } = await appServerRequest(this.connection, 'pdf/openResource', { documentId: id, resourceId: snapshot.resourceId });
			if (opened) { snapshot.complete(); }
			signal.throwIfAborted();
			return opened ? { document, revision: snapshot.revision } : undefined;
		} catch (error) {
			document.dispose();
			throw error;
		} finally {
			snapshot.dispose();
		}
	}

	public async open(bytes: Uint8Array, signal: AbortSignal): Promise<IPdfDocument> {
		signal.throwIfAborted();
		if (this.connection.capabilities?.contracts.pdf?.version !== 1) {
			throw new Error(localize('pdf.unavailable', 'Connect to an aspdf service that supports version 1.'));
		}
		const id = createUuid();
		const document = new AppServerPdfDocument(this.connection, id);
		try {
			await appServerRequest(this.connection, 'pdf/open', { documentId: id, size: bytes.length });
			for (let offset = 0; offset < bytes.length;) {
				signal.throwIfAborted();
				const end = Math.min(offset + 192 * 1024, bytes.length);
				const chunk = bytes.buffer instanceof ArrayBuffer
					? new Uint8Array(bytes.buffer, bytes.byteOffset + offset, end - offset)
					: bytes.slice(offset, end);
				const result = await appServerRequest(this.connection, 'pdf/append', { documentId: id, offset, dataBase64: encodeBase64(VSBuffer.wrap(chunk)) });
				if (result.nextOffset !== offset + chunk.length) { throw new Error(localize('pdf.invalidResponse', 'The PDF service returned inconsistent content.')); }
				offset = result.nextOffset;
			}
			signal.throwIfAborted();
			return document;
		} catch (error) {
			document.dispose();
			throw error;
		}
	}
}

class AppServerPdfDocument implements IPdfDocument {
	private revision = 0;
	private disposed = false;

	constructor(private readonly connection: AppServerProtocolClient, private readonly id: string) { }

	public async page(page: number, dimension: number, signal: AbortSignal, edit?: PdfAnnotationEdit): Promise<PdfPage> {
		this.check(signal);
		const generation = this.connection.generation;
		const operationId = !edit && this.connection.capabilities?.contracts.pdfRender?.version === 1 ? createUuid() : undefined;
		const abort = () => {
			if (operationId && this.connection.generation === generation && !this.disposed) {
				void appServerRequest(this.connection, 'pdf/cancelRender', { operationId }).catch(() => undefined);
			} else if (edit) {
				this.dispose();
			}
		};
		signal.addEventListener('abort', abort, { once: true });
		try {
			const params = { documentId: this.id, revision: this.revision, page, dimension };
			const result = operationId
				? await appServerRequest(this.connection, 'pdf/renderPage', { ...params, operationId })
				: await appServerRequest(this.connection, 'pdf/page', {
					...params, edit: edit?.kind === 'ink' ? { ...edit, points: edit.points.map(point => ({ ...point })) } : edit ?? null,
				});
			this.check(signal);
			this.revision = result.revision;
			return result;
		} catch (error) {
			signal.throwIfAborted();
			throw error;
		} finally { signal.removeEventListener('abort', abort); }
	}

	public image(page: PdfPage, signal: AbortSignal): Promise<Uint8Array> { return this.read(page, true, signal); }
	public export(page: PdfPage, signal: AbortSignal): Promise<Uint8Array> { return this.read(page, false, signal); }

	private async read(page: PdfPage, image: boolean, signal: AbortSignal): Promise<Uint8Array> {
		this.check(signal);
		const bytes = new Uint8Array(image ? page.imageSize : page.fileSize);
		for (let offset = 0; offset < bytes.length;) {
			this.check(signal);
			const result = await appServerRequest(this.connection, 'pdf/read', { documentId: this.id, revision: page.revision, image, imageSha256: image ? page.imageSha256 : null, offset, maxBytes: Math.min(192 * 1024, bytes.length - offset) });
			const chunk = decodeBase64(result.dataBase64).buffer;
			if (!chunk.length || chunk.length > bytes.length - offset || result.eof !== (offset + chunk.length === bytes.length)) {
				throw new Error(localize('pdf.invalidResponse', 'The PDF service returned inconsistent content.'));
			}
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return bytes;
	}

	private check(signal: AbortSignal): void {
		signal.throwIfAborted();
		if (this.disposed) { throw new Error(localize('pdf.closed', 'This PDF document is closed.')); }
	}

	public dispose(): void {
		if (this.disposed) { return; }
		this.disposed = true;
		void appServerRequest(this.connection, 'pdf/close', { documentId: this.id }).catch(() => undefined);
	}

	public [Symbol.dispose](): void { this.dispose(); }
}
