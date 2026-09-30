import { Emitter } from '../../../base/common/event.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import type { IResolvableEditorModel } from '../../../platform/editor/common/editor.js';

/** Editor-facing resolution and lifetime, independent of the backing data owner. */
export class EditorModel implements IResolvableEditorModel {
	private readonly lifetime = new DisposableStore();
	private readonly resources = new DisposableStore();
	private readonly willDispose = new Emitter<void>();
	readonly onWillDispose = this.willDispose.event;
	private resolved = false;

	constructor() {
		// Notify before releasing references. The store marks disposal first, so listeners
		// can reenter dispose without sending another notification.
		this.lifetime.add(this.resources);
		this.lifetime.add(this.willDispose);
		this.lifetime.add(toDisposable(() => this.willDispose.fire()));
	}

	async resolve(): Promise<void> {
		this.resolved = true;
	}

	isResolved(): boolean {
		return this.resolved && !this.isDisposed();
	}

	isDisposed(): boolean {
		return this.lifetime.isDisposed;
	}

	protected _register<T extends IDisposable>(resource: T): T {
		return this.resources.add(resource);
	}

	dispose(): void {
		this.lifetime.dispose();
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}
