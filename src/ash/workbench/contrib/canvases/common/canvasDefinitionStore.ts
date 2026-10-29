import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue, type IObservable, type IReader } from '../../../../base/common/observable.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { canvasOwnerKey, compareCanvasDefinitions, isOpenableExtensionCanvasDefinition, type CanvasDefinitionSnapshot, type ICanvasDefinition, type ICanvasOwner } from './canvas.js';

export interface ICanvasDefinitionSource {
	readonly owner: ICanvasOwner;
	readonly includeDefinition?: (definition: ICanvasDefinition) => boolean;
	listCanvases(): Promise<CanvasDefinitionSnapshot>;
}

/** Keeps one owner's last authoritative listing while refreshes settle. Results cannot cross owners. */
export class CanvasDefinitionStore extends Disposable {
	readonly definitions = observableValue<readonly ICanvasDefinition[]>(this, []);
	private source: ICanvasDefinitionSource | undefined;
	private generation = 0;
	private queued = false;
	private runningGeneration = -1;

	constructor(source: (reader: IReader) => ICanvasDefinitionSource | undefined, private readonly logPrefix: string, @ILogService private readonly log: ILogService) {
		super();
		this._register(autorun(reader => {
			const next = source(reader);
			if ((!next || !this.source) ? next !== this.source : canvasOwnerKey(next.owner) !== canvasOwnerKey(this.source.owner)) {
				this.generation++;
				this.definitions.set([], undefined);
			}
			this.source = next;
			if (next) { this.schedule(); }
		}));
	}

	private schedule(): void {
		if (this.queued) { return; }
		this.queued = true;
		queueMicrotask(() => { if (this.runningGeneration !== this.generation && !this.isDisposed) { void this.refresh(); } });
	}

	private async refresh(): Promise<void> {
		this.queued = false;
		const source = this.source;
		const generation = this.generation;
		if (!source || this.isDisposed) { return; }
		this.runningGeneration = generation;
		try {
			const result = await source.listCanvases();
			if (result !== undefined && !this.isDisposed && generation === this.generation && source === this.source) {
				const definitions = result.filter(source.includeDefinition ?? isOpenableExtensionCanvasDefinition).sort(compareCanvasDefinitions);
				if (JSON.stringify(definitions) !== JSON.stringify(this.definitions.get())) { this.definitions.set(definitions, undefined); }
			}
		} catch (error) { if (!this.isDisposed) { this.log.error(this.logPrefix, 'Could not list Canvas definitions', error); } }
		finally {
			if (this.runningGeneration === generation) {
				this.runningGeneration = -1;
				if (this.queued && !this.isDisposed) { void this.refresh(); }
			}
		}
	}
}
