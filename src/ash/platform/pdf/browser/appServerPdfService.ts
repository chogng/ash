import { decodeBase64, encodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { createUuid } from '../../../base/common/uuid.js';
import { localize } from '../../../nls.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import type { IPdfDocument, IPdfService, PdfAnnotationEdit, PdfPage } from '../common/pdfService.js';

/** Generated transport values stay at this adapter; viewers consume only PDF domain values. */
export class AppServerPdfService implements IPdfService {
	constructor(private readonly connection: AppServerProtocolClient) { }

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
				const chunk = bytes.subarray(offset, offset + 192 * 1024);
				const result = await appServerRequest(this.connection, 'pdf/append', { documentId: id, offset, dataBase64: encodeBase64(VSBuffer.wrap(chunk.slice())) });
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
		const abort = () => this.dispose();
		signal.addEventListener('abort', abort, { once: true });
		try {
			const result = await appServerRequest(this.connection, 'pdf/page', {
				documentId: this.id, revision: this.revision, page, dimension, edit: edit?.kind === 'ink' ? { ...edit, points: edit.points.map(point => ({ ...point })) } : edit ?? null,
			});
			this.check(signal);
			this.revision = result.revision;
			return result;
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
