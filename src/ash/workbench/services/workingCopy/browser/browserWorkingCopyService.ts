import { Emitter } from "../../../../base/common/event.js";
import { DisposableMap, Disposable, DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { getOrSet } from "../../../../base/common/map.js";
import { type URI } from "../../../../base/common/uri.js";
import { type IWorkingCopy, type IWorkingCopyService } from "../common/workingCopyService.js";
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';

/** Browser registry for editor-domain working copies. */
export class BrowserWorkingCopyService extends Disposable implements IWorkingCopyService {
	private readonly copies = new Map<string, Set<IWorkingCopy>>();
	private readonly dirtySubscriptions = this._register(new DisposableMap<IWorkingCopy>());
	private readonly _onDidRegister = this._register(new Emitter<IWorkingCopy>());
	private readonly _onDidUnregister = this._register(new Emitter<IWorkingCopy>());
	private readonly _onDidChangeDirty = this._register(new Emitter<void>());

	readonly onDidRegister = this._onDidRegister.event;
	readonly onDidUnregister = this._onDidUnregister.event;
	readonly onDidChangeDirty = this._onDidChangeDirty.event;

	constructor(@IUriIdentityService private readonly uriIdentity: IUriIdentityService) {
		super();
		this._register(toDisposable(() => this.copies.clear()));
	}

	register(workingCopy: IWorkingCopy): ReturnType<typeof toDisposable> {
		this.assertNotDisposed();
		validateWorkingCopy(workingCopy);
		const key = this.uriIdentity.asCanonicalUri(workingCopy.resource).toString();
		if (this.dirtySubscriptions.has(workingCopy)) throw new Error(`Working copy is already registered: ${key}`);
		const copies = getOrSet(this.copies, key, new Set<IWorkingCopy>());
		copies.add(workingCopy);
		const lifetime = new DisposableStore();
		lifetime.add(this.uriIdentity.retainUri(workingCopy.resource));
		lifetime.add(workingCopy.onDidChangeDirty(() => this._onDidChangeDirty.fire()));
		this.dirtySubscriptions.set(workingCopy, lifetime);
		this._onDidRegister.fire(workingCopy);
		if (workingCopy.isDirty) this._onDidChangeDirty.fire();
		let registered = true;
		return toDisposable(() => {
			if (!registered) return;
			registered = false;
			const current = this.copies.get(key);
			if (!current || !current.delete(workingCopy)) return;
			this.dirtySubscriptions.deleteAndDispose(workingCopy);
			if (current.size === 0) this.copies.delete(key);
			this._onDidUnregister.fire(workingCopy);
			if (workingCopy.isDirty) this._onDidChangeDirty.fire();
		});
	}

	get hasDirtyWorkingCopies(): boolean {
		return this.getAll().some(workingCopy => workingCopy.isDirty);
	}

	get(resource: URI): readonly IWorkingCopy[] {
		// Registrations retain their lifetime keys when the provider's casing policy changes.
		return this.getAll().filter(copy => this.uriIdentity.extUri.isEqual(resource, copy.resource));
	}

	getAll(): readonly IWorkingCopy[] {
		return [...this.copies.values()].flatMap(copies => [...copies]);
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
