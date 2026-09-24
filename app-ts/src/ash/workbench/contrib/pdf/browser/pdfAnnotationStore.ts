import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { type URI } from "../../../../base/common/uri.js";
import { FileKind, type IFileService } from "../../../../platform/files/common/files.js";
import { emptyPdfAnnotationDocument, parsePdfAnnotationDocument, serializePdfAnnotationDocument, type PdfAnnotationDocument } from "../common/pdfAnnotations.js";

/** Annotation sidecar data plus its conditional-write revision. */
export interface PdfAnnotationSnapshot {
	readonly document: PdfAnnotationDocument;
	readonly revision: string | undefined;
}

/** Persistence seam for PDF annotations that must not rewrite the source PDF. */
export interface IPdfAnnotationStore {
	load(resource: URI, signal: AbortSignal): Promise<PdfAnnotationSnapshot>;
	save(resource: URI, document: PdfAnnotationDocument, expectedRevision: string | undefined, signal: AbortSignal): Promise<PdfAnnotationSnapshot>;
}

/** Persists versioned PDF annotations as a JSON companion file in the workspace. */
export class WorkspacePdfAnnotationStore implements IPdfAnnotationStore {
	constructor(private readonly files: IFileService) {}

	async load(resource: URI, signal: AbortSignal): Promise<PdfAnnotationSnapshot> {
		throwIfCancelled(signal, "PDF annotation loading was cancelled");
		const sidecar = pdfAnnotationSidecarResource(resource);
		const entries = await this.files.readDirectory(pdfAnnotationDirectory(resource));
		throwIfCancelled(signal, "PDF annotation loading was cancelled");
		if (!entries.some((entry) => entry.kind === FileKind.File && entry.resource.toString() === sidecar.toString())) {
			return Object.freeze({ document: emptyPdfAnnotationDocument(), revision: undefined });
		}
		const content = await this.files.readFile(sidecar);
		throwIfCancelled(signal, "PDF annotation loading was cancelled");
		return Object.freeze({ document: parsePdfAnnotationDocument(content.content), revision: content.revision });
	}

	async save(resource: URI, document: PdfAnnotationDocument, expectedRevision: string | undefined, signal: AbortSignal): Promise<PdfAnnotationSnapshot> {
		throwIfCancelled(signal, "PDF annotation saving was cancelled");
		const content = serializePdfAnnotationDocument(document);
		const saved = await this.files.writeFile({ resource: pdfAnnotationSidecarResource(resource), content, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
		throwIfCancelled(signal, "PDF annotation saving was cancelled");
		return Object.freeze({ document: parsePdfAnnotationDocument(content), revision: saved.revision });
	}
}

/** Returns the visible, versioned companion resource used to persist PDF annotations. */
export function pdfAnnotationSidecarResource(resource: URI): URI {
	return resource.withPath(`${resource.path}.ash-annotations.json`).withoutQuery().withoutFragment();
}

function pdfAnnotationDirectory(resource: URI): URI {
	const path = resource.path;
	const separator = path.lastIndexOf("/");
	return resource.withPath(separator <= 0 ? "/" : path.slice(0, separator + 1)).withoutQuery().withoutFragment();
}
