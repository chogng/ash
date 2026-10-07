import type { IAction } from '../../../../base/common/actions.js';
import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
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
}

export interface IMultiDiffSourceResolverService {
	readonly _serviceBrand: undefined;
	registerResolver(resolver: IMultiDiffSourceResolver): IDisposable;
	resolve(uri: URI): Promise<IResolvedMultiDiffSource | undefined>;
	sourceActions(): readonly IAction[];
	primaryRepositoryAction(input: MultiDiffEditorInput): IAction | undefined;
}

/** Window-scoped registry; Sessions and other products own their source state. */
export class MultiDiffSourceResolverService implements IMultiDiffSourceResolverService {
	readonly _serviceBrand = undefined;
	private readonly resolvers = new Set<IMultiDiffSourceResolver>();

	registerResolver(resolver: IMultiDiffSourceResolver): IDisposable {
		if (this.resolvers.has(resolver)) throw new Error('Multi-diff source resolver is already registered');
		this.resolvers.add(resolver);
		return toDisposable(() => this.resolvers.delete(resolver));
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
