import { raceCancellationError } from '../../../../base/common/async.js';
import { throwIfCancelled, type CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import type { IEditorPane } from '../../../common/editor.js';
import { IOutlineService, type IOutline, type IOutlineCreator, type OutlineTarget } from './outline.js';

/** Owns creator registration, while each consumer owns the outline it requests. */
export class OutlineService extends Disposable implements IOutlineService {
	public readonly _serviceBrand = undefined;
	private readonly creators = new Set<IOutlineCreator<IEditorPane, any>>();
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;

	constructor() {
		super();
		this._register(toDisposable(() => this.creators.clear()));
	}

	public canCreateOutline(editor: IEditorPane): boolean {
		return [...this.creators].some(creator => creator.matches(editor));
	}

	public async createOutline(editor: IEditorPane, target: OutlineTarget, token: CancellationToken): Promise<IOutline<any> | undefined> {
		this.assertNotDisposed();
		throwIfCancelled(token);
		const creator = [...this.creators].find(candidate => candidate.matches(editor));
		if (!creator) return undefined;
		const pending = creator.createOutline(editor, target, token).then(outline => {
			if (token.isCancellationRequested || this.isDisposed || !this.creators.has(creator)) { outline?.dispose(); return undefined; }
			return outline;
		});
		const outline = await raceCancellationError(pending, token);
		if (this.isDisposed || token.isCancellationRequested || !this.creators.has(creator)) {
			outline?.dispose();
			return undefined;
		}
		return outline;
	}

	public registerOutlineCreator(creator: IOutlineCreator<IEditorPane, any>): IDisposable {
		this.assertNotDisposed();
		if (this.creators.has(creator)) throw new Error('Outline creator is already registered');
		this.creators.add(creator);
		this.changed.fire();
		return toDisposable(() => {
			if (this.creators.delete(creator)) this.changed.fire();
		});
	}
}

registerSingleton(IOutlineService, OutlineService, InstantiationType.Delayed);
