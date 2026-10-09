import { TestUriIdentityServices } from '../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { BrowserWorkingCopyService } from "../../browser/browserWorkingCopyService.js";
import type { IWorkingCopy } from "../../common/workingCopyService.js";
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { MemoryFileService } from '../../../../contrib/bulkEdit/test/browser/bulkEditTestServices.js';

const uriIdentityServices = new TestUriIdentityServices();
suiteTeardown(() => uriIdentityServices.dispose());

test("BrowserWorkingCopyService indexes and unregisters format-specific copies", () => {
	using service = uriIdentityServices.createInstance(BrowserWorkingCopyService);
	using copy = new FakeWorkingCopy(URI.file("C:\\project\\paper.ash-academic"));
	const registered: IWorkingCopy[] = [];
	const unregistered: IWorkingCopy[] = [];
	using registeredListener = service.onDidRegister(value => registered.push(value));
	using unregisteredListener = service.onDidUnregister(value => unregistered.push(value));

	using registration = service.register(copy);
	assert.deepEqual(service.get(copy.resource), [copy]);
	assert.deepEqual(registered, [copy]);

	registration.dispose();
	assert.deepEqual(service.get(copy.resource), []);
	assert.deepEqual(unregistered, [copy]);
});

test('BrowserWorkingCopyService publishes every working copy dirty state change', () => {
	using service = uriIdentityServices.createInstance(BrowserWorkingCopyService);
	using first = new FakeWorkingCopy(URI.file('C:\\project\\first.ts'));
	using second = new FakeWorkingCopy(URI.file('C:\\project\\second.ts'));
	const changes: boolean[] = [];
	using listener = service.onDidChangeDirty(() => changes.push(service.hasDirtyWorkingCopies));
	using firstRegistration = service.register(first);
	using secondRegistration = service.register(second);

	first.setDirty(true);
	second.setDirty(true);
	first.setDirty(false);
	second.setDirty(false);

	assert.deepEqual(changes, [true, true, true, false]);
});

test('BrowserWorkingCopyService reports initially dirty registrations and removal', () => {
	using service = uriIdentityServices.createInstance(BrowserWorkingCopyService);
	using copy = new FakeWorkingCopy(URI.file('C:\\project\\draft.ts'));
	copy.setDirty(true);
	const changes: boolean[] = [];
	using listener = service.onDidChangeDirty(() => changes.push(service.hasDirtyWorkingCopies));
	const registration = service.register(copy);
	registration.dispose();
	assert.deepEqual(changes, [true, false]);
});

test('file aliases find every format-specific working copy and unregister through their original lifetime', () => {
	using files = new FileService();
	const provider = new class extends MemoryFileService {
		public override capabilities = FileSystemProviderCapabilities.FileReadWrite;
	}([]);
	using registeredProvider = files.registerProvider('file', provider);
	using services = new TestUriIdentityServices(files);
	using copies = services.createInstance(BrowserWorkingCopyService);
	using first = new FakeWorkingCopy(URI.file('/workspace/Main.txt'));
	using second = new FakeWorkingCopy(URI.file('/workspace/MAIN.txt'));
	const firstRegistration = copies.register(first);
	using secondRegistration = copies.register(second);
	first.setDirty(true);
	assert.deepEqual(copies.get(URI.file('/workspace/main.txt')), [first, second]);
	assert.equal(copies.hasDirtyWorkingCopies, true);
	assert.throws(() => copies.register(first), /already registered/);
	registeredProvider.dispose();
	using replacement = files.registerProvider('file', new MemoryFileService([]));
	assert.deepEqual(copies.get(first.resource), [first]);
	assert.deepEqual(copies.get(second.resource), [second]);
	firstRegistration.dispose();
	assert.deepEqual([copies.get(first.resource), copies.hasDirtyWorkingCopies], [[], false]);
});

class FakeWorkingCopy extends Disposable implements IWorkingCopy {
	private readonly dirtyEmitter = this._register(new Emitter<void>());
	private readonly externalChangeEmitter = this._register(new Emitter<void>());
	readonly onDidChangeDirty = this.dirtyEmitter.event;
	readonly onDidChangeExternalChange = this.externalChangeEmitter.event;
	readonly onDidChangeContent = this.dirtyEmitter.event;
	isDirty = false;
	readonly hasExternalChange = false;
	readonly backupKind = "text" as const;

	constructor(readonly resource: URI) {
		super();
	}

	setDirty(isDirty: boolean): void {
		if (this.isDirty === isDirty) return;
		this.isDirty = isDirty;
		this.dirtyEmitter.fire();
	}

	async save(_signal: AbortSignal): Promise<void> { }
	backup(): string { return ""; }
	restoreBackup(): void { }
	async saveAs(_resource: URI, _signal: AbortSignal): Promise<void> { }
	async revert(_signal: AbortSignal): Promise<void> { }
}
