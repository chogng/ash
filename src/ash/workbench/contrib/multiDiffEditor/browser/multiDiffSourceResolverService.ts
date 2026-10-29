import { Emitter, type Event } from '../../../../base/common/event.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { MultiDiffEditorInput, MultiDiffEditorInputItem, MultiDiffEditorSource } from './multiDiffEditorInput.js';

export const IMultiDiffSourceResolverService = createServiceIdentifier<IMultiDiffSourceResolverService>('multiDiffSourceResolverService');

export interface IResolvedMultiDiffSource {
	readonly resource: URI;
	readonly resources: readonly MultiDiffEditorInputItem[];
	readonly label: string;
	readonly source?: MultiDiffEditorSource;
}

export interface IMultiDiffSourceResolver {
	canHandleUri(uri: URI): boolean;
	resolveDiffSource(uri: URI): Promise<IResolvedMultiDiffSource>;
	sourceActions(): readonly IAction[];
	primaryRepositoryAction(input: MultiDiffEditorInput): IAction | undefined;
	repositoryActions?(input: MultiDiffEditorInput): readonly IAction[];
}

export interface IMultiDiffSourceResolverService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	notifyChanged(): void;
	registerResolver(resolver: IMultiDiffSourceResolver): IDisposable;
	resolve(uri: URI): Promise<IResolvedMultiDiffSource | undefined>;
	sourceActions(): readonly IAction[];
	primaryRepositoryAction(input: MultiDiffEditorInput): IAction | undefined;
	repositoryActions?(input: MultiDiffEditorInput): readonly IAction[];
}

/** Window-scoped registry; Sessions and other products own their source state. */
export class MultiDiffSourceResolverService extends Disposable implements IMultiDiffSourceResolverService {
	readonly _serviceBrand = undefined;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	notifyChanged(): void { this.changed.fire(); }
	repositoryActions(input: MultiDiffEditorInput): readonly IAction[] { return [...this.resolvers].flatMap(resolver => resolver.repositoryActions?.(input) ?? []); }
	private readonly resolvers = new Set<IMultiDiffSourceResolver>();

	registerResolver(resolver: IMultiDiffSourceResolver): IDisposable {
		if (this.resolvers.has(resolver)) throw new Error('Multi-diff source resolver is already registered');
		this.resolvers.add(resolver);
		this.changed.fire();
		return toDisposable(() => { this.resolvers.delete(resolver); this.changed.fire(); });
	}

	async resolve(uri: URI): Promise<IResolvedMultiDiffSource | undefined> {
		for (const resolver of this.resolvers) {
			if (resolver.canHandleUri(uri)) return resolver.resolveDiffSource(uri);
		}
		return undefined;
	}

	sourceActions(): readonly IAction[] {
		return [...this.resolvers].flatMap(resolver => resolver.sourceActions());
	}

	primaryRepositoryAction(input: MultiDiffEditorInput): IAction | undefined {
		for (const resolver of this.resolvers) {
			const action = resolver.primaryRepositoryAction(input);
			if (action) return action;
		}
		return undefined;
	}
}
