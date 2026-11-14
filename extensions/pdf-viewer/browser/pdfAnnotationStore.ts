import { throwIfCancelled } from '../../../src/ash/base/common/cancellation.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { FileKind, type IFileService } from '../../../src/ash/platform/files/common/files.js';
import { emptyPdfAnnotationDocument, parsePdfAnnotationDocument, serializePdfAnnotationDocument, type PdfAnnotationDocument } from '../common/pdfAnnotations.js';

/** Annotation sidecar data plus its conditional-write revision. */
export interface PdfAnnotationSnapshot {
	readonly document: PdfAnnotationDocument;
	/** Undefined means the sidecar was absent, so the first save must only create it. */
	readonly revision: string | undefined;
}

/** Persistence seam for PDF annotations that must not rewrite the source PDF. */
export interface IPdfAnnotationStore {
	load(resource: URI, signal: AbortSignal): Promise<PdfAnnotationSnapshot>;
	save(resource: URI, document: PdfAnnotationDocument, expectedRevision: string | undefined, signal: AbortSignal): Promise<PdfAnnotationSnapshot>;
}

/** Persists versioned PDF annotations as a JSON companion file in the workspace. */
export class WorkspacePdfAnnotationStore implements IPdfAnnotationStore {
	constructor(private readonly files: IFileService) { }

	async load(resource: URI, signal: AbortSignal): Promise<PdfAnnotationSnapshot> {
		throwIfCancelled(signal, 'PDF annotation loading was cancelled');
		const sidecar = pdfAnnotationSidecarResource(resource);
		const entries = await this.files.readDirectory(URI.joinPath(sidecar, '..'));
		throwIfCancelled(signal, 'PDF annotation loading was cancelled');
		// Entries belong to this directory; match its filename rather than provider-specific
		// URI spelling (for example, Windows drive casing in disk directory listings).
		const name = sidecar.path.slice(sidecar.path.lastIndexOf('/') + 1);
		if (!entries.some((entry) => entry.kind === FileKind.File && entry.name === name)) {
			return Object.freeze({ document: emptyPdfAnnotationDocument(), revision: undefined });
		}
		const content = await this.files.readFile(sidecar);
		throwIfCancelled(signal, 'PDF annotation loading was cancelled');
		return Object.freeze({ document: parsePdfAnnotationDocument(content.content), revision: content.revision });
	}

	async save(resource: URI, document: PdfAnnotationDocument, expectedRevision: string | undefined, signal: AbortSignal): Promise<PdfAnnotationSnapshot> {
		throwIfCancelled(signal, 'PDF annotation saving was cancelled');
		const content = serializePdfAnnotationDocument(document);
		const saved = await this.files.writeFile({ resource: pdfAnnotationSidecarResource(resource), content, ...(expectedRevision === undefined ? {} : { expectedRevision }) }, { create: true, overwrite: expectedRevision !== undefined }, signal);
		throwIfCancelled(signal, 'PDF annotation saving was cancelled');
		return Object.freeze({ document: parsePdfAnnotationDocument(content), revision: saved.revision });
	}
}

/** Returns the visible, versioned companion resource used to persist PDF annotations. */
export function pdfAnnotationSidecarResource(resource: URI): URI {
	return resource.withEncodedPath(`${resource.toEncodedComponents().path}.ash-annotations.json`).with({ query: null, fragment: null });
}
