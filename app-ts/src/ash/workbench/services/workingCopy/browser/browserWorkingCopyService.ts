import { Emitter } from "../../../../base/common/event.js";
import { DisposableMap, Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { getOrSet } from "../../../../base/common/map.js";
import { type URI } from "../../../../base/common/uri.js";
import { type IWorkingCopy, type IWorkingCopyService } from "../common/workingCopyService.js";

/** Browser registry for editor-domain working copies. */
export class BrowserWorkingCopyService extends Disposable implements IWorkingCopyService {
	private readonly copies = new Map<string, Set<IWorkingCopy>>();
	private readonly dirtySubscriptions = this._register(new DisposableMap<IWorkingCopy>());
	private readonly _onDidRegister = this._register(new Emitter<IWorkingCopy>());
	private readonly _onDidUnregister = this._register(new Emitter<IWorkingCopy>());
	private readonly _onDidChangeDirty = this._register(new Emitter<void>());
	private lastHasDirtyWorkingCopies = false;

	readonly onDidRegister = this._onDidRegister.event;
	readonly onDidUnregister = this._onDidUnregister.event;
	readonly onDidChangeDirty = this._onDidChangeDirty.event;

	constructor() {
		super();
		this._register(toDisposable(() => this.copies.clear()));
	}

	register(workingCopy: IWorkingCopy): ReturnType<typeof toDisposable> {
		this.assertNotDisposed();
		validateWorkingCopy(workingCopy);
		const key = workingCopy.resource.toString();
		const copies = getOrSet(this.copies, key, new Set<IWorkingCopy>());
		if (copies.has(workingCopy)) throw new Error(`Working copy is already registered: ${key}`);
		copies.add(workingCopy);
		this.dirtySubscriptions.set(workingCopy, workingCopy.onDidChangeDirty(() => this.publishDirtyChange()));
		this._onDidRegister.fire(workingCopy);
		this.publishDirtyChange();
		let registered = true;
		return toDisposable(() => {
			if (!registered) return;
			registered = false;
			const current = this.copies.get(key);
			if (!current || !current.delete(workingCopy)) return;
			this.dirtySubscriptions.deleteAndDispose(workingCopy);
			if (current.size === 0) this.copies.delete(key);
			this._onDidUnregister.fire(workingCopy);
			this.publishDirtyChange();
		});
	}

	get hasDirtyWorkingCopies(): boolean {
		return this.getAll().some(workingCopy => workingCopy.isDirty);
	}

	get(resource: URI): readonly IWorkingCopy[] {
		return [...this.copies.get(resource.toString()) ?? []];
	}

	getAll(): readonly IWorkingCopy[] {
		return [...this.copies.values()].flatMap(copies => [...copies]);
	}

	private publishDirtyChange(): void {
		const hasDirtyWorkingCopies = this.hasDirtyWorkingCopies;
		if (hasDirtyWorkingCopies === this.lastHasDirtyWorkingCopies) return;
		this.lastHasDirtyWorkingCopies = hasDirtyWorkingCopies;
		this._onDidChangeDirty.fire();
	}
}

function validateWorkingCopy(workingCopy: IWorkingCopy): void {
	if (!workingCopy || typeof workingCopy !== "object" || !workingCopy.resource || typeof workingCopy.resource.toString !== "function") {
		throw new TypeError("Working copy registration requires a resource");
	}
	if (typeof workingCopy.isDirty !== "boolean" || typeof workingCopy.onDidChangeDirty !== "function" || typeof workingCopy.onDidChangeContent !== "function" || typeof workingCopy.backup !== "function" || typeof workingCopy.restoreBackup !== "function" || typeof workingCopy.save !== "function" || typeof workingCopy.saveAs !== "function" || typeof workingCopy.revert !== "function") {
		throw new TypeError("Working copy registration requires content events, backup restoration, save, saveAs, and revert operations");
	}
}
