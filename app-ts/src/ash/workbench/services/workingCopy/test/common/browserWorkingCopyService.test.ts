import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { BrowserWorkingCopyService } from "../../browser/browserWorkingCopyService.js";
import type { IWorkingCopy } from "../../common/workingCopyService.js";

test("BrowserWorkingCopyService indexes and unregisters format-specific copies", () => {
	using service = new BrowserWorkingCopyService();
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

test('BrowserWorkingCopyService publishes aggregate dirty state changes', () => {
	using service = new BrowserWorkingCopyService();
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

	assert.deepEqual(changes, [true, false]);
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

	async save(_signal: AbortSignal): Promise<void> {}
	backup(): string { return ""; }
	restoreBackup(): void {}
	async saveAs(_resource: URI, _signal: AbortSignal): Promise<void> {}
	async revert(_signal: AbortSignal): Promise<void> {}
}
