import assert from "node:assert/strict";
import { test } from "mocha";
import { isCancellationError } from "../../../../../base/common/errors.js";
import { Emitter } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";
import { BrowserTextModelService } from "../../../textmodelResolver/browser/browserTextModelService.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { type TextResourceChangeEvent, type TextResourceContent, type TextResourceResolveRequest, type TextResourceSaveRequest, type ITextResourceStore } from "../../../../../editor/common/services/textResourceStore.js";
import { BrowserWorkingCopyService } from "../../../workingCopy/browser/browserWorkingCopyService.js";
import { type IWorkingCopy } from "../../../workingCopy/common/workingCopyService.js";
import { BrowserWorkspaceEditService } from "../../browser/browserWorkspaceEditService.js";
import { FileKind, FileNotFoundError, type FileDeleteMode, type FileExistingTargetBehavior, type FileMissingTargetBehavior, type IFileService } from "../../../../../platform/files/common/files.js";

test("workspace edits preflight every document before mutating and persist closed resources", async () => {
	const first = URI.file("C:\\project\\first.ts");
	const second = URI.file("C:\\project\\second.ts");
	using store = new MemoryResourceStore([[first, "alpha"], [second, "bravo"]]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	const files = new MemoryFileService([[first, "alpha"], [second, "bravo"]]);
	using service = new BrowserWorkspaceEditService(models, workingCopies, files);

	await service.apply({ entries: [
		{ kind: "textDocument", resource: first, edits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1)), text: "one" }] },
		{ kind: "textDocument", resource: second, edits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1)), text: "two" }] },
	] });

	assert.equal(store.text(first), "one");
	assert.equal(store.text(second), "two");
	assert.deepEqual(store.saved, [first.toString(), second.toString()]);
});

test("workspace edits keep open working copies dirty instead of saving behind the editor", async () => {
	const resource = URI.file("C:\\project\\open.ts");
	using store = new MemoryResourceStore([[resource, "alpha"]]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using service = new BrowserWorkspaceEditService(models, workingCopies, new MemoryFileService([[resource, "alpha"]]));
	const reference = await models.acquire({ resource }, new AbortController().signal);
	const registration = workingCopies.register(workingCopy(reference));

	await service.apply({ entries: [{ kind: "textDocument", resource, version: reference.model.version, edits: [{ range: Range.fromPositions(new Position((0) + 1, (5) + 1)), text: "!" }] }] });

	assert.equal(reference.model.getText(), "alpha!");
	assert.equal(reference.isDirty, true);
	assert.deepEqual(store.saved, []);
	registration.dispose();
	reference.dispose();
});

test("workspace edit preflight rejects stale or invalid edits without changing any document", async () => {
	const first = URI.file("C:\\project\\first.ts");
	const second = URI.file("C:\\project\\second.ts");
	using store = new MemoryResourceStore([[first, "alpha"], [second, "bravo"]]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using service = new BrowserWorkspaceEditService(models, workingCopies, new MemoryFileService([[first, "alpha"], [second, "bravo"]]));
	const reference = await models.acquire({ resource: first }, new AbortController().signal);

	await assert.rejects(service.apply({ entries: [
		{ kind: "textDocument", resource: first, version: reference.model.version, edits: [{ range: Range.fromPositions(new Position((0) + 1, (5) + 1)), text: "!" }] },
		{ kind: "textDocument", resource: second, edits: [{ range: Range.fromPositions(new Position((4) + 1, (0) + 1)), text: "invalid" }] },
	] }), /outside|line/i);

	assert.equal(reference.model.getText(), "alpha");
	assert.equal(store.text(second), "bravo");
	assert.deepEqual(store.saved, []);
	reference.dispose();
});

test("workspace edit preflight rejects a changed target content baseline atomically", async () => {
	const first = URI.file("C:\\workspace\\first.ts");
	const second = URI.file("C:\\workspace\\second.ts");
	using store = new MemoryResourceStore([[first, "first"], [second, "changed"]]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	using service = new BrowserWorkspaceEditService(models, workingCopies, new MemoryFileService([[first, "first"], [second, "changed"]]));

	await assert.rejects(service.apply({ entries: [
		{ kind: "textDocument", resource: first, expectedText: "first", edits: [{ range: Range.fromPositions(new Position((0) + 1, (5) + 1)), text: "!" }] },
		{ kind: "textDocument", resource: second, expectedText: "second", edits: [{ range: Range.fromPositions(new Position((0) + 1, (6) + 1)), text: "!" }] },
	] }), /content.*stale/);
	assert.equal(store.text(first), "first");
	assert.equal(store.text(second), "changed");
});

test("workspace edit applies create then text edit in protocol order", async () => {
	const created = URI.file("C:\\workspace\\created.ts");
	using store = new MemoryResourceStore([]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	const files = new MemoryFileService([]);
	using service = new BrowserWorkspaceEditService(models, workingCopies, files);

	await service.apply({ entries: [
		{ kind: "create", resource: created, existing: "error" },
		{ kind: "textDocument", resource: created, expectedText: "", edits: [{ range: Range.fromPositions(new Position((0) + 1, (0) + 1)), text: "export const ready = true;" }] },
	] });

	assert.equal(files.has(created), true);
	assert.equal(store.text(created), "export const ready = true;");
});

test("workspace edit rolls back created resources when a later operation fails", async () => {
	const created = URI.file("C:\\workspace\\created.ts");
	const target = URI.file("C:\\workspace\\target.ts");
	using store = new MemoryResourceStore([]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	const files = new MemoryFileService([[target, "occupied"]]);
	files.failRename = true;
	using service = new BrowserWorkspaceEditService(models, workingCopies, files);

	await assert.rejects(service.apply({ entries: [
		{ kind: "create", resource: created, existing: "error" },
		{ kind: "rename", source: created, target: URI.file("C:\\workspace\\moved.ts"), existing: "error" },
	] }), /injected rename failure/);

	assert.equal(files.has(created), false);
	assert.equal(files.text(target), "occupied");
});

test("workspace edits classify caller cancellation before mutating resources", async () => {
	const created = URI.file("C:\\workspace\\cancelled.ts");
	using store = new MemoryResourceStore([]);
	using models = new BrowserTextModelService(store);
	using workingCopies = new BrowserWorkingCopyService();
	const files = new MemoryFileService([]);
	using service = new BrowserWorkspaceEditService(models, workingCopies, files);
	const controller = new AbortController();
	controller.abort("superseded");

	await assert.rejects(service.apply({ entries: [
		{ kind: "create", resource: created, existing: "error" },
	] }, controller.signal), error => isCancellationError(error) && error.reason === "superseded");

	assert.equal(files.has(created), false);
});

function workingCopy(reference: Awaited<ReturnType<BrowserTextModelService["acquire"]>>): IWorkingCopy {
	return {
		resource: reference.resource,
		backupKind: "text",
		get isDirty() { return reference.isDirty; },
		get hasExternalChange() { return reference.hasExternalChange; },
		onDidChangeDirty: reference.onDidChangeDirty,
		onDidChangeExternalChange: reference.onDidChangeExternalChange,
		onDidChangeContent: listener => reference.model.onDidChangeContent(() => listener()),
		backup: () => reference.model.getText(),
		restoreBackup: content => reference.model.reset(content),
		save: signal => reference.save(signal),
		saveAs: async () => {},
		revert: signal => reference.revert(signal),
		dispose() {},
		[Symbol.dispose]() {},
	};
}

class MemoryResourceStore implements ITextResourceStore {
	private readonly changes = new Emitter<TextResourceChangeEvent>();
	readonly onDidChange = this.changes.event;
	readonly saved: string[] = [];
	private readonly resources = new Map<string, { text: string; revision: number }>();

	constructor(resources: readonly (readonly [URI, string])[]) {
		for (const [resource, text] of resources) this.resources.set(resource.toString(), { text, revision: 1 });
	}

	text(resource: URI): string {
		return this.require(resource).text;
	}

	async resolve(request: TextResourceResolveRequest): Promise<TextResourceContent> {
		const entry = this.resources.get(request.resource.toString());
		if (!entry && request.bootstrapText !== undefined) return { resource: request.resource, text: request.bootstrapText, revision: undefined };
		if (!entry) throw new Error(`Unknown resource ${request.resource.toString()}`);
		return { resource: request.resource, text: entry.text, revision: String(entry.revision) };
	}

	async save(request: TextResourceSaveRequest): Promise<{ readonly revision: string }> {
		let entry = this.resources.get(request.resource.toString());
		if (!entry) {
			entry = { text: "", revision: 0 };
			this.resources.set(request.resource.toString(), entry);
		}
		entry.text = request.text;
		entry.revision += 1;
		this.saved.push(request.resource.toString());
		return { revision: String(entry.revision) };
	}

	dispose(): void {
		this.changes.dispose();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}

	private require(resource: URI): { text: string; revision: number } {
		const entry = this.resources.get(resource.toString());
		if (!entry) throw new Error(`Unknown resource ${resource.toString()}`);
		return entry;
	}
}

class MemoryFileService implements IFileService {
	readonly onDidChangeFiles = new Emitter<{ readonly resources: readonly URI[] | undefined }>().event;
	private readonly resources = new Map<string, string>();
	failRename = false;

	constructor(resources: readonly (readonly [URI, string])[]) {
		for (const [resource, text] of resources) this.resources.set(resource.toString(), text);
	}

	has(resource: URI): boolean { return this.resources.has(resource.toString()); }
	text(resource: URI): string { const text = this.resources.get(resource.toString()); if (text === undefined) throw new Error(`Unknown resource ${resource.toString()}`); return text; }
	async stat(resource: URI) { if (!this.has(resource)) throw new FileNotFoundError(resource); return { resource, kind: FileKind.File, sizeBytes: this.text(resource).length, readonly: false, modifiedAtMillis: undefined }; }
	async readDirectory(): Promise<readonly never[]> { return []; }
	async readFile(resource: URI) { return { resource, content: this.text(resource), revision: this.text(resource) }; }
	async readFileBytes(resource: URI) { return { resource, bytes: new TextEncoder().encode(this.text(resource)), revision: this.text(resource) }; }
	async writeFile(request: { readonly resource: URI; readonly content: string }) { this.resources.set(request.resource.toString(), request.content); return { stat: await this.stat(request.resource), revision: request.content }; }
	async createFile(resource: URI, existing: FileExistingTargetBehavior) {
		if (this.has(resource)) {
			if (existing === "error") throw new Error("FileSystemOperationFailed");
			if (existing === "ignore") return this.stat(resource);
		}
		this.resources.set(resource.toString(), "");
		return this.stat(resource);
	}
	async rename(source: URI, target: URI, existing: FileExistingTargetBehavior): Promise<void> {
		if (this.failRename) throw new Error("injected rename failure");
		const sourceText = this.text(source);
		if (this.has(target)) {
			if (existing === "error") throw new Error("FileSystemOperationFailed");
			if (existing === "ignore") return;
		}
		this.resources.delete(source.toString());
		this.resources.set(target.toString(), sourceText);
	}
	async delete(resource: URI, missing: FileMissingTargetBehavior, _mode: FileDeleteMode): Promise<void> {
		if (!this.resources.delete(resource.toString()) && missing === "error") throw new Error("FileSystemOperationFailed");
	}
}
