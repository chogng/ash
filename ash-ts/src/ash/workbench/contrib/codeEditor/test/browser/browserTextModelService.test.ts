import { TestLanguageConfigurationService } from '../../../../../editor/test/common/modes/testLanguageConfigurationService.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { isCancellationError } from "../../../../../base/common/errors.js";
import { Emitter } from "../../../../../base/common/event.js";
import { URI } from "../../../../../base/common/uri.js";
import { BrowserTextModelService } from "../../../../services/textmodelResolver/browser/browserTextModelService.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { TextModelConflictError } from "../../../../services/textmodelResolver/common/textModelResourceService.js";
import { type IFileChangeEvent } from "../../../../../platform/files/common/files.js";
import { TextFileContentSource, TextFileSaveConflictError, type ITextFileService, type TextFileSaveRequest } from "../../../../services/textfile/common/textFileService.js";
import { BrowserTextResourceStore } from "../../browser/browserTextResourceStore.js";
import { LanguageService } from "../../../../../editor/common/services/languageService.js";

test("Stanza text model service shares one model and preserves edits across panes", async () => {
	const textFiles = new TestTextFileService("from disk");
	using models = new BrowserTextModelService(new BrowserTextResourceStore(textFiles));
	const input = { resource: URI.file("C:\\project\\main.ts"), initialText: "bootstrap" };
	const first = await models.acquire(input, new AbortController().signal);
	const second = await models.acquire({ ...input, initialText: "stale" }, new AbortController().signal);

	assert.equal(first.model, second.model);
	assert.equal(first.model.getText(), "bootstrap");
	assert.equal(textFiles.resolveCount, 1);
	first.model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (9) + 1)),
		text: "edited",
	}]);
	assert.equal(second.model.getText(), "edited");

	first.dispose();
	assert.equal(second.model.getText(), "edited");
	second.dispose();
	assert.throws(() => second.model.getText(), /disposed/);
});

test("Stanza text model service creates the model with its resource and resolved language", async () => {
	const textFiles = new TestTextFileService("#!/usr/bin/env demo\nprint('ok')");
	using languageService = new LanguageService();
	using demo = languageService.registerLanguage({ id: "demo", firstLine: "#!.*\\bdemo" });
	using rust = languageService.registerLanguage({ id: "rust", extensions: [".rs"] });
	using models = new BrowserTextModelService(new BrowserTextResourceStore(textFiles), { languageService });
	const resource = URI.file("C:\\project\\script.cgi");
	const inferred = await models.acquire({ resource }, new AbortController().signal);

	assert.equal(inferred.model.uri.toString(), resource.toString());
	assert.equal(inferred.model.getLanguageId(), "demo");
	inferred.dispose();

	const explicitResource = URI.file("C:\\project\\explicit.txt");
	const explicit = await models.acquire({ resource: explicitResource, languageId: "rust" }, new AbortController().signal);
	assert.equal(explicit.model.getLanguageId(), "rust");
	explicit.dispose();
});

test("Stanza text model acquisition delegates absent bootstrap content and observes cancellation", async () => {
	const textFiles = new TestTextFileService("from disk");
	using models = new BrowserTextModelService(new BrowserTextResourceStore(textFiles));
	const resource = URI.file("C:\\project\\main.ts");
	const reference = await models.acquire({ resource }, new AbortController().signal);
	assert.equal(reference.model.getText(), "from disk");
	reference.dispose();

	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(models.acquire({ resource }, cancelled.signal), isCancellationError);
});

test('Stanza text model service restores undo and redo after the final reference is released', async () => {
	const resource = URI.file('C:\\project\\history.ts');
	const textFiles = new TestTextFileService('alpha');
	using models = new BrowserTextModelService(new BrowserTextResourceStore(textFiles));
	let reference = await models.acquire({ resource }, new AbortController().signal);
	reference.model.applyOperations([{ range: Range.fromPositions(new Position((0) + 1, (5) + 1)), text: '!' }]);
	await reference.save(new AbortController().signal);
	const releasedModel = reference.model;
	reference.dispose();

	reference = await models.acquire({ resource }, new AbortController().signal);
	assert.notEqual(reference.model, releasedModel);
	assert.equal(reference.model.canUndo(), true);
	reference.model.undo();
	assert.equal(reference.model.getText(), 'alpha');
	await reference.save(new AbortController().signal);
	reference.dispose();

	reference = await models.acquire({ resource }, new AbortController().signal);
	assert.equal(reference.model.canRedo(), true);
	reference.model.redo();
	assert.equal(reference.model.getText(), 'alpha!');
	reference.dispose();
});

test('Stanza text model service drops retained history when persisted content changed', async () => {
	const resource = URI.file('C:\\project\\history.ts');
	const textFiles = new TestTextFileService('alpha');
	using models = new BrowserTextModelService(new BrowserTextResourceStore(textFiles));
	const first = await models.acquire({ resource }, new AbortController().signal);
	first.model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (5) + 1)), text: '!' }]);
	await first.save(new AbortController().signal);
	first.dispose();
	textFiles.setText('external');

	const reopened = await models.acquire({ resource }, new AbortController().signal);
	assert.equal(reopened.model.getText(), 'external');
	assert.equal(reopened.model.canUndo(), false);
	reopened.dispose();
});

test("Stanza text model references track dirty content, save snapshots, and explicitly revert", async () => {
	const textFiles = new TestTextFileService("from disk");
	using models = new BrowserTextModelService(new BrowserTextResourceStore(textFiles));
	const reference = await models.acquire({ resource: URI.file("C:\\project\\main.ts") }, new AbortController().signal);
	let dirtyChanges = 0;
	using listener = reference.onDidChangeDirty(() => dirtyChanges += 1);

	reference.model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (4) + 1)),
		text: "saved",
	}]);
	assert.equal(reference.isDirty, true);
	assert.equal(dirtyChanges, 1);

	await reference.save(new AbortController().signal);
	assert.deepEqual(textFiles.savedTexts, ["saved disk"]);
	assert.equal(reference.isDirty, false);
	assert.equal(dirtyChanges, 2);

	reference.model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (5) + 1)),
		text: " locally",
	}]);
	assert.equal(reference.isDirty, true);
	textFiles.setText("external\r\ncontent");
	await reference.revert(new AbortController().signal);
	assert.equal(reference.model.getText(), "external\r\ncontent");
	assert.equal(reference.model.canUndo(), false);
	assert.equal(reference.model.canRedo(), false);
	assert.equal(reference.isDirty, false);
	assert.equal(dirtyChanges, 4);
});

test("Stanza text model save tolerates its final reference closing before I/O completes", async () => {
	const pending = deferred<void>();
	const textFiles: ITextFileService = {
		onDidChangeFiles: inertFileChanges,
		async resolve(request) {
			return {
				resource: request.resource,
				text: "from disk",
				source: TextFileContentSource.FileSystem,
				revision: "revision-1",
				encoding: "utf8",
			};
		},
		async save() {
			await pending.promise;
			return { revision: "revision-2" };
		},
	};
	using models = new BrowserTextModelService(new BrowserTextResourceStore(textFiles));
	const reference = await models.acquire({ resource: URI.file("C:\\project\\main.ts") }, new AbortController().signal);
	reference.model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1)),
		text: "edited ",
	}]);
	const saving = reference.save(new AbortController().signal);
	reference.dispose();
	pending.resolve();
	await saving;
});

test("Stanza text model preserves the source CRLF convention when saving", async () => {
	const textFiles = new TestTextFileService("first\r\nsecond");
	using models = new BrowserTextModelService(new BrowserTextResourceStore(textFiles));
	const reference = await models.acquire({ resource: URI.file("C:\\project\\main.ts") }, new AbortController().signal);
	assert.equal(reference.model.getText(), "first\r\nsecond");
	reference.model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1)),
		text: "saved",
	}]);

	await reference.save(new AbortController().signal);
	assert.deepEqual(textFiles.savedTexts, ["saved\r\nsecond"]);
});

test("Stanza text model refuses to overwrite externally changed content", async () => {
	const textFiles = new TestTextFileService("from disk");
	using models = new BrowserTextModelService(new BrowserTextResourceStore(textFiles));
	const reference = await models.acquire({ resource: URI.file("C:\\project\\main.ts") }, new AbortController().signal);
	reference.model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1)),
		text: "local ",
	}]);
	textFiles.setText("external change");

	await assert.rejects(reference.save(new AbortController().signal), error => error instanceof TextModelConflictError);
	assert.equal(reference.isDirty, true);
	assert.deepEqual(textFiles.savedTexts, []);
});

test("Stanza text model reloads clean external changes and marks dirty models conflicted", async () => {
	const resource = URI.file("C:\\project\\main.ts");
	const textFiles = new TestTextFileService("from disk");
	using models = new BrowserTextModelService(new BrowserTextResourceStore(textFiles));
	const reference = await models.acquire({ resource }, new AbortController().signal);

	textFiles.setText("external clean");
	textFiles.fireExternalChange(resource);
	await waitFor(() => reference.model.getText() === "external clean");
	assert.equal(reference.isDirty, false);
	assert.equal(reference.hasExternalChange, false);

	const stableVersion = reference.model.version;
	textFiles.fireExternalChange(resource);
	await waitFor(() => textFiles.resolveCount === 3);
	assert.equal(reference.model.version, stableVersion);
	assert.equal(reference.hasExternalChange, false);

	reference.model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1)),
		text: "local ",
	}]);
	textFiles.setText("external dirty");
	textFiles.fireExternalChange(resource);
	assert.equal(reference.hasExternalChange, true);
	await assert.rejects(reference.save(new AbortController().signal), TextModelConflictError);
	await reference.revert(new AbortController().signal);
	assert.equal(reference.model.getText(), "external dirty");
	assert.equal(reference.hasExternalChange, false);
});

class TestTextFileService implements ITextFileService {
	resolveCount = 0;
	readonly savedTexts: string[] = [];
	private readonly fileChanges = new Emitter<IFileChangeEvent>();
	private revision = 1;
	readonly onDidChangeFiles = this.fileChanges.event;

	constructor(private text: string) {}

	async resolve(request: { resource: URI; bootstrapText?: string }) {
		this.resolveCount += 1;
		return {
			resource: request.resource,
			text: request.bootstrapText ?? this.text,
			source: request.bootstrapText === undefined ? TextFileContentSource.FileSystem : TextFileContentSource.Bootstrap,
			revision: request.bootstrapText === undefined ? this.currentRevision() : undefined,
			encoding: "utf8" as const,
		};
	}

	async save(request: TextFileSaveRequest): Promise<{ readonly revision: string | undefined }> {
		if (request.expectedRevision !== undefined && request.expectedRevision !== this.currentRevision()) {
			throw new TextFileSaveConflictError(request.resource);
		}
		this.savedTexts.push(request.text);
		this.text = request.text;
		this.revision += 1;
		return { revision: this.currentRevision() };
	}

	setText(text: string): void {
		this.text = text;
		this.revision += 1;
	}

	fireExternalChange(resource: URI): void {
		this.fileChanges.fire(Object.freeze({ resources: Object.freeze([resource]) }));
	}

	private currentRevision(): string {
		return `revision-${this.revision}`;
	}
}

function inertFileChanges() {
	return {
		dispose() {},
		[Symbol.dispose]() {},
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 0));
	}
	assert.fail("Timed out waiting for Stanza external file synchronization");
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(resolver => {
		resolve = resolver;
	});
	return { promise, resolve };
}

test('Workbench file models observe their hosts language configuration registrations', async () => {
	using configurations = new TestLanguageConfigurationService();
	using models = new BrowserTextModelService(new BrowserTextResourceStore(new TestTextFileService('{value}')), {
		languageConfigurationService: configurations,
	});
	using reference = await models.acquire({ resource: URI.file('/example.ts'), languageId: 'typescript' }, new AbortController().signal);
	const pairs = reference.model.bracketPairs;
	assert.equal(pairs.matchBracket(new Position(1, 1)), null);
	const registration = configurations.register('typescript', { brackets: [['{', '}']] });
	assert.deepEqual(pairs.matchBracket(new Position(1, 1)), [new Range(1, 1, 1, 2), new Range(1, 7, 1, 8)]);
	registration.dispose();
	assert.equal(pairs.matchBracket(new Position(1, 1)), null);
});
