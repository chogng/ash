import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { extUri } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import type { ArtifactCard, ArtifactCatalogSource } from './artifactWorkspaceRegistry.js';

/** Read-only catalog projection. File metadata is cached, never written on opening or browsing. */
export class ArtifactCatalog extends Disposable {
	private readonly value = observableValue<readonly ArtifactCard[]>(this, []);
	public readonly cards = this.value;
	private readonly modified = new Map<string, number | undefined>();
	private generation = 0;
	private readonly refreshSoon = this._register(new RunOnceScheduler(() => this.refresh(), 0));

	constructor(
		private readonly sources: readonly ArtifactCatalogSource[],
		@IFileService private readonly files: IFileService,
	) {
		super();
		this._register(autorun(reader => {
			for (const source of sources) source.cards.read(reader);
			this.refresh();
		}));
		this._register(files.onDidChangeFiles(event => {
			let affected = false;
			for (const card of this.value.get()) {
				if (card.resource && (!event.resources || event.resources.some(resource => extUri.isEqualOrParent(card.resource!, resource) || extUri.isEqualOrParent(resource, card.resource!)))) {
					this.modified.delete(card.resource.toString());
					affected = true;
				}
			}
			if (affected) this.refreshSoon.schedule();
		}));
	}

	private refresh(): void {
		const generation = ++this.generation;
		const cards = this.sources.flatMap(source => source.cards.get());
		const resources = new Map(cards.flatMap(card => card.resource ? [[card.resource.toString(), card.resource] as const] : []));
		for (const key of this.modified.keys()) if (!resources.has(key)) this.modified.delete(key);
		const publish = () => this.value.set(cards.map(card => ({ ...card, modifiedAt: card.resource ? this.modified.get(card.resource.toString()) ?? card.modifiedAt : card.modifiedAt })), undefined);
		publish();
		const missing = [...resources].filter(([key]) => !this.modified.has(key));
		if (!missing.length) return;
		void Promise.all(missing.map(async ([key, resource]) => {
			// A missing or inaccessible timestamp does not make the artifact itself unavailable.
			try {
				return [key, (await this.files.stat(resource)).modifiedAtMillis] as const;
			} catch {
				return [key, undefined] as const;
			}
		})).then(results => {
			if (this.isDisposed || generation !== this.generation) return;
			for (const [key, modifiedAt] of results) this.modified.set(key, modifiedAt);
			publish();
		});
	}
}
