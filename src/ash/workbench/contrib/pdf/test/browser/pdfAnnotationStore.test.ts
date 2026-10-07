import { Event } from '../../../../../base/common/event.js';
import { createTestFileService } from '../../../../test/common/testEditorServices.js';
import { type IFileSystemProvider, type IFileWriteOptions, type IFileWriteResult, FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { toDisposable, Disposable, type IDisposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { FileKind, type IFileWriteRequest } from "../../../../../platform/files/common/files.js";
import { WorkspacePdfAnnotationStore, pdfAnnotationSidecarResource } from "../../../../../workbench/contrib/pdf/browser/pdfAnnotationStore.js";
import { emptyPdfAnnotationDocument, parsePdfAnnotationDocument } from "../../../../../workbench/contrib/pdf/common/pdfAnnotations.js";

test("PDF annotation store returns an empty document when no sidecar exists", async () => {
	const resource = URI.file("/workspace/paper.pdf");
	const files = new TestFileService();
	using fileService = createTestFileService(files);
	const store = new WorkspacePdfAnnotationStore(fileService);

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
	using fileService = createTestFileService(files);
	const store = new WorkspacePdfAnnotationStore(fileService);

	const loaded = await store.load(resource, new AbortController().signal);
	const saved = await store.save(resource, loaded.document, loaded.revision, new AbortController().signal);

	assert.equal(files.readFileRequests[0]?.toString(), sidecar.toString());
	assert.equal(files.writeRequests[0]?.resource.toString(), sidecar.toString());
	assert.equal(files.writeRequests[0]?.expectedRevision, "before");
	assert.deepEqual(parsePdfAnnotationDocument(files.writeRequests[0]?.content ?? ""), emptyPdfAnnotationDocument());
	assert.equal(saved.revision, "after");
});

class TestFileService implements IFileSystemProvider {
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy;
	public readonly onDidChangeCapabilities = Event.None;
	public watch(): IDisposable { return Disposable.None; }

	readonly onDidChangeFiles = () => toDisposable(() => { });
	entries: readonly { readonly resource: URI; readonly name: string; readonly kind: FileKind; }[] = [];
	content = "";
	revision = "revision";
	readonly readFileRequests: URI[] = [];
	readonly writeRequests: IFileWriteRequest[] = [];

	async stat(resource: URI) {
		return { resource, kind: FileKind.File, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined };
	}

	async readDirectory(): Promise<readonly { readonly resource: URI; readonly name: string; readonly kind: FileKind; }[]> {
		return this.entries;
	}

	async readFile(resource: URI) {
		this.readFileRequests.push(resource);
		return { resource, bytes: new TextEncoder().encode(this.content), revision: this.revision };
	}

	public async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		if (!options.overwrite) { throw new Error('PDF annotation tests do not paste files'); }
		const request = { resource, content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) };
		this.writeRequests.push(request);
		return {
			stat: { resource: request.resource, kind: FileKind.File, sizeBytes: request.content.length, readonly: false, modifiedAtMillis: undefined },
			revision: "after",
		};
	}

	async createFile(): Promise<never> { throw new Error("PDF annotation tests do not create empty files"); }
	async createDirectory(): Promise<never> { throw new Error("PDF annotation tests do not create directories"); }
	async copy(): Promise<void> { throw new Error("Copy is not used in this test"); }
	async rename(): Promise<never> { throw new Error("PDF annotation tests do not rename files"); }
	async delete(): Promise<never> { throw new Error("PDF annotation tests do not delete files"); }
}
