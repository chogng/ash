import type { ToolSourceProvenance } from '../../../../../../../.build/protocol/typescript/index.js';
import { IAgentToolsApi } from '../../../../../platform/agentHost/common/agentToolsApi.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { canceled, isCancellationError, onUnexpectedError } from '../../../../../base/common/errors.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { derived, observableValue } from '../../../../../base/common/observable.js';
import { isToolSet, type ILanguageModelToolsService, type IToolData, type IToolSet } from '../../common/tools/languageModelToolsService.js';

interface Catalog {
	readonly tools: readonly IToolData[];
	readonly sets: readonly IToolSet[];
	/** Derived query indexes point to the objects above and are replaced with that snapshot. */
	readonly names: ReadonlyMap<IToolData | IToolSet, string>;
	readonly references: ReadonlyMap<string, IToolData | IToolSet>;
}

const emptyCatalog: Catalog = Object.freeze({ tools: Object.freeze([]), sets: Object.freeze([]), names: new Map(), references: new Map() });

/** Converts the transport catalog; the backend remains the only tool registry. */
export class LanguageModelToolsService extends Disposable implements ILanguageModelToolsService {
	private readonly catalog = observableValue<Catalog>(this, emptyCatalog);
	readonly toolSets = derived<Iterable<IToolSet>>(reader => this.catalog.read(reader).sets);
	private pending: Promise<void> | undefined;
	private readAgain = false;
	private requested = false;
	private readonly didChangeTools = this._register(new Emitter<void>());
	readonly onDidChangeTools = this.didChangeTools.event;
	private epoch = 0;
	private disposed = false;

	constructor(
		@IAgentToolsApi private readonly api: IAgentToolsApi,
		@IAppServerApi private readonly appServer: IAppServerApi,
	) {
		super();
		const connectionState = appServer.onConnectionState(state => {
			if (state !== 'ready') this.clear();
			else if (this.requested) this.refreshInBackground();
		});
		this._register(toDisposable(() => connectionState.dispose()));
		this._register(toDisposable(() => { this.disposed = true; this.clear(); }));
		this._register(api.onDidChangeTools(() => {
			// Collapse invalidations during a read into one further read before publishing.
			this.readAgain = true;
			if (this.requested) this.refreshInBackground();
		}));
	}

	get isAvailable(): boolean { return this.api.isAvailable; }

	refresh(): Promise<void> {
		if (this.disposed) return Promise.reject(canceled());
		this.requested = true;
		if (this.pending) return this.pending;
		const epoch = this.epoch;
		const generation = this.appServer.connectionGeneration;
		const pending = (async () => {
			let result;
			do {
				this.readAgain = false;
				result = await this.api.read();
				if (this.disposed || epoch !== this.epoch || generation !== this.appServer.connectionGeneration) throw canceled();
			} while (this.readAgain);
			const tools: readonly IToolData[] = Object.freeze(result.tools.map(tool => Object.freeze({
				id: tool.name,
				toolReferenceName: tool.name,
				displayName: tool.name,
				modelDescription: tool.description,
				canBeReferencedInPrompt: tool.exposure === 'direct' || tool.exposure === 'deferred',
				source: tool.source,
				sourceDetails: Object.freeze(tool.sourceChain.map(sourceDetail)),
				exposure: tool.exposure,
				authority: tool.authority,
			})));
			const byId = new Map(tools.map(tool => [tool.id, tool]));
			const sets = Object.freeze(result.toolSets.map(set => {
				const members = Object.freeze(set.tools.map(id => byId.get(id)).filter((tool): tool is IToolData => tool !== undefined && tool.exposure !== 'hidden'));
				return Object.freeze({
					id: set.id, source: set.source, sourceId: set.sourceId,
					// An empty source has a reserved segment; actual '@' IDs are encoded as '%40'.
					referenceName: `${set.source}/${set.sourceId ? encodeURIComponent(set.sourceId) : '@'}`,
					getTools: () => members,
				});
			}));
			const externalGroups = new Map<IToolData, IToolSet>();
			const references = new Map<string, IToolData | IToolSet>();
			for (const set of sets) {
				for (const tool of set.getTools()) {
					if (!tool.canBeReferencedInPrompt) continue;
					references.set(`${set.referenceName}/${tool.toolReferenceName}`, tool);
					if (tool.source === 'mcp' || tool.source === 'extension') externalGroups.set(tool, set);
				}
			}
			const names = new Map<IToolData | IToolSet, string>();
			for (const tool of tools) {
				if (!tool.canBeReferencedInPrompt) continue;
				const group = externalGroups.get(tool);
				const name = group ? `${group.referenceName}/${tool.toolReferenceName}` : tool.toolReferenceName;
				names.set(tool, name);
				references.set(name, tool);
				references.set(tool.id, tool);
			}
			for (const set of sets) {
				if (![...set.getTools()].some(tool => tool.canBeReferencedInPrompt)) continue;
				const name = set.source === 'mcp' ? `${set.referenceName}/*` : set.referenceName;
				names.set(set, name);
				references.set(name, set);
			}
			this.catalog.set({ tools, sets, names, references });
			this.didChangeTools.fire();
		})().finally(() => {
			if (this.pending === pending) this.pending = undefined;
		});
		this.pending = pending;
		return pending;
	}

	private refreshInBackground(): void {
		if (this.pending) return;
		void this.refresh().catch(error => { if (!isCancellationError(error)) onUnexpectedError(error); });
	}

	getAllToolsIncludingDisabled(): Iterable<IToolData> { return this.catalog.get().tools; }

	getFullReferenceNames(): Iterable<string> { return this.catalog.get().names.values(); }

	getFullReferenceName(tool: IToolData | IToolSet, toolSet?: IToolSet): string {
		if (isToolSet(tool)) return tool.source === 'mcp' ? `${tool.referenceName}/*` : tool.referenceName;
		if (toolSet) return `${toolSet.referenceName}/${tool.toolReferenceName}`;
		const catalog = this.catalog.get();
		// Another consumer can refresh while a picker still holds its immutable item.
		const current = catalog.references.get(tool.id);
		return catalog.names.get(tool) ?? (current ? catalog.names.get(current) : undefined) ?? tool.toolReferenceName;
	}

	getToolByFullReferenceName(name: string): IToolData | IToolSet | undefined {
		return this.catalog.get().references.get(name);
	}

	private clear(): void {
		this.epoch++;
		this.pending = undefined;
		const changed = this.catalog.get() !== emptyCatalog;
		this.catalog.set(emptyCatalog);
		if (changed && !this.disposed) this.didChangeTools.fire();
	}
}

function sourceDetail(source: ToolSourceProvenance): string {
	switch (source.type) {
		case 'product': return source.component;
		case 'plugin': return `${source.pluginId}@${source.version}`;
		case 'mcp': return source.serverId;
		case 'dynamic': return source.name;
		case 'extension': return source.id;
		case 'system': return source.id;
	}
}
