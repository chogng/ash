import assert from "node:assert/strict";
import { test } from "mocha";
import { toDisposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { FileKind, type IFileService, type IFileWriteRequest } from "../../../../../platform/files/common/files.js";
import { WorkspacePdfAnnotationStore, pdfAnnotationSidecarResource } from "../../../../../workbench/contrib/pdf/browser/pdfAnnotationStore.js";
import { emptyPdfAnnotationDocument, parsePdfAnnotationDocument } from "../../../../../workbench/contrib/pdf/common/pdfAnnotations.js";

test("PDF annotation store returns an empty document when no sidecar exists", async () => {
	const resource = URI.file("/workspace/paper.pdf");
	const files = new TestFileService();
	const store = new WorkspacePdfAnnotationStore(files);

	const snapshot = await store.load(resource, new AbortController().signal);

	assert.deepEqual(snapshot.document, emptyPdfAnnotationDocument());
	assert.equal(snapshot.revision, undefined);
	assert.equal(files.readFileRequests.length, 0);
});

test("PDF annotation store reads and conditionally writes its sibling sidecar", async () => {
	const resource = URI.file("/workspace/paper.pdf");
	const sidecar = pdfAnnotationSidecarResource(resource);
	const files = new TestFileService();
	files.entries = [{ resource: sidecar, name: "paper.pdf.ash-annotations.json", kind: FileKind.File }];
	files.content = "{\n  \"version\": 1,\n  \"annotations\": []\n}\n";
	files.revision = "before";
	const store = new WorkspacePdfAnnotationStore(files);

	const loaded = await store.load(resource, new AbortController().signal);
	const saved = await store.save(resource, loaded.document, loaded.revision, new AbortController().signal);

	assert.equal(files.readFileRequests[0]?.toString(), sidecar.toString());
	assert.equal(files.writeRequests[0]?.resource.toString(), sidecar.toString());
	assert.equal(files.writeRequests[0]?.expectedRevision, "before");
	assert.deepEqual(parsePdfAnnotationDocument(files.writeRequests[0]?.content ?? ""), emptyPdfAnnotationDocument());
	assert.equal(saved.revision, "after");
});

class TestFileService implements IFileService {
	readonly onDidChangeFiles = () => toDisposable(() => {});
	entries: readonly { readonly resource: URI; readonly name: string; readonly kind: FileKind }[] = [];
	content = "";
	revision = "revision";
	readonly readFileRequests: URI[] = [];
	readonly writeRequests: IFileWriteRequest[] = [];

	async stat(resource: URI) {
		return { resource, kind: FileKind.File, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined };
	}

	async readDirectory(): Promise<readonly { readonly resource: URI; readonly name: string; readonly kind: FileKind }[]> {
		return this.entries;
	}

	async readFile(resource: URI) {
		this.readFileRequests.push(resource);
		return { resource, content: this.content, revision: this.revision };
	}

	async readFileBytes(resource: URI) {
		return { resource, bytes: new Uint8Array(), revision: this.revision };
	}

	async writeFile(request: IFileWriteRequest) {
		this.writeRequests.push(request);
		return {
			stat: { resource: request.resource, kind: FileKind.File, sizeBytes: request.content.length, readonly: false, modifiedAtMillis: undefined },
			revision: "after",
		};
	}

	async createFile(): Promise<never> { throw new Error("PDF annotation tests do not create empty files"); }
	async rename(): Promise<never> { throw new Error("PDF annotation tests do not rename files"); }
	async delete(): Promise<never> { throw new Error("PDF annotation tests do not delete files"); }
}
