import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../../../base/common/event.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import { URI } from "../../../../../base/common/uri.js";
import { BrowserWorkingCopyService } from "../../browser/browserWorkingCopyService.js";
import { WorkingCopyBackupTracker } from "../../browser/workingCopyBackupTracker.js";
import { type IWorkingCopyBackupService, type WorkingCopyBackup } from "../../common/workingCopyBackupService.js";
import { type IWorkingCopy } from "../../common/workingCopyService.js";

test("working-copy backup tracker persists the latest dirty content and deletes clean backups", async () => {
	using workingCopies = new BrowserWorkingCopyService();
	const backups = new MemoryBackups();
	const ownerWindow = new TestWindow();
	using tracker = new WorkingCopyBackupTracker(workingCopies, backups, ownerWindow as unknown as Window);
	using copy = new TestWorkingCopy(URI.file("C:\\project\\main.ts"));
	using registration = workingCopies.register(copy);

	copy.change("first");
	copy.change("latest");
	ownerWindow.runTimers();
	await tracker.flush();
	assert.equal((await backups.list())[0]?.content, "latest");

	copy.markClean();
	ownerWindow.runTimers();
	await tracker.flush();
	assert.deepEqual(await backups.list(), []);
});

class TestWorkingCopy extends Disposable implements IWorkingCopy {
	private readonly dirtyChanges = this._register(new Emitter<void>());
	private readonly contentChanges = this._register(new Emitter<void>());
	readonly resource;
	readonly backupKind = "text" as const;
	readonly onDidChangeDirty = this.dirtyChanges.event;
	readonly onDidChangeContent = this.contentChanges.event;
	readonly onDidChangeExternalChange = () => ({ dispose() {}, [Symbol.dispose]() {} });
	isDirty = false;
	readonly hasExternalChange = false;
	private content = "";

	constructor(resource: URI) { super(); this.resource = resource; }
	change(content: string): void { this.content = content; const becameDirty = !this.isDirty; this.isDirty = true; this.contentChanges.fire(); if (becameDirty) this.dirtyChanges.fire(); }
	markClean(): void { this.isDirty = false; this.dirtyChanges.fire(); }
	backup(): string { return this.content; }
	restoreBackup(content: string): void { this.change(content); }
	async save(): Promise<void> { this.markClean(); }
	async saveAs(): Promise<void> { this.markClean(); }
	async revert(): Promise<void> { this.markClean(); }
}

class MemoryBackups extends Disposable implements IWorkingCopyBackupService {
	private readonly values = new Map<string, WorkingCopyBackup>();
	async list(): Promise<readonly WorkingCopyBackup[]> { return [...this.values.values()]; }
	async store(backup: WorkingCopyBackup): Promise<void> { this.values.set(backup.resource.toString(), backup); }
	async delete(resource: URI): Promise<void> { this.values.delete(resource.toString()); }
	switchWorkspace(): void { this.values.clear(); }
}

class TestWindow {
	private nextTimer = 1;
	private readonly timers = new Map<number, () => void>();
	setTimeout(callback: () => void): number { const id = this.nextTimer++; this.timers.set(id, callback); return id; }
	clearTimeout(id: number): void { this.timers.delete(id); }
	runTimers(): void { const callbacks = [...this.timers.values()]; this.timers.clear(); for (const callback of callbacks) callback(); }
}
