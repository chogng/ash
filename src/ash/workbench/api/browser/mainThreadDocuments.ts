import { Disposable, DisposableMap, DisposableStore } from '../../../base/common/lifecycle.js';
import { throwIfCancelled } from '../../../base/common/cancellation.js';
import type { ITextModel } from '../../../editor/common/model.js';
import { IModelService } from '../../../editor/common/services/model.js';
import { IExtensionHostApi, type ExtensionDocumentSnapshot, type ExtensionHostFleetSnapshot, type JsonValue } from '../../../platform/extensionHost/common/extensionHostApi.js';

/** Model events belong to the window connection; a restarted extension receives a fresh open sequence. */
export class MainThreadDocuments extends Disposable {
	private readonly modelListeners = this._register(new DisposableMap<string, DisposableStore>());
	private readonly observers = this._register(new DisposableMap<string, DocumentObserver>());

	constructor(
		private readonly timeoutMillis: number,
		private readonly reportError: (error: unknown) => void,
		@IModelService private readonly models: IModelService,
		@IExtensionHostApi private readonly api: IExtensionHostApi,
	) {
		super();
		this._register(models.onModelAdded(model => this.addModel(model)));
		this._register(models.onModelRemoved(model => {
			this.emit({ type: 'close', document: { ...extensionDocumentSnapshot(model) } });
			this.modelListeners.deleteAndDispose(model.id);
		}));
		this._register(models.onModelLanguageChanged(({ model, oldLanguageId }) => {
			const snapshot = extensionDocumentSnapshot(model);
			this.emit({ type: 'close', document: { ...snapshot, languageId: oldLanguageId } });
			this.emit({ type: 'open', document: { ...snapshot } });
		}));
		for (const model of models.getModels()) this.addModel(model);
	}

	public update(snapshot: ExtensionHostFleetSnapshot): void {
		const retained = new Set<string>();
		for (const runtime of snapshot.extensions) {
			if (runtime.lifecycle !== 'ready' || runtime.incarnation === undefined) continue;
			for (const registration of runtime.registrations) {
				if (registration.kind !== 'textDocumentEvents') continue;
				const identity = { extensionId: runtime.id, activationGeneration: runtime.activationGeneration, incarnation: runtime.incarnation, registrationId: registration.registrationId };
				const key = JSON.stringify(identity);
				retained.add(key);
				if (this.observers.has(key)) continue;
				const observer: DocumentObserver = new DocumentObserver(event => this.api.invoke({ ...identity, operation: 'documentEvent', payload: event, deadlineUnixMillis: Date.now() + this.timeoutMillis }, observer.signal), this.reportError);
				this.observers.set(key, observer);
				for (const model of this.models.getModels()) observer.send({ type: 'open', document: { ...extensionDocumentSnapshot(model) } });
			}
		}
		for (const key of this.observers.keys()) if (!retained.has(key)) this.observers.deleteAndDispose(key);
	}

	public clear(): void { this.observers.clearAndDisposeAll(); }

	private addModel(model: ITextModel): void {
		const listeners = new DisposableStore();
		this.modelListeners.set(model.id, listeners);
		listeners.add(model.onDidChangeContent(change => this.emit({
			type: 'change', document: { ...extensionDocumentSnapshot(model) }, reason: change.reason,
			contentChanges: change.changes.map(edit => ({
				range: { start: { line: edit.range.startLineNumber - 1, character: edit.range.startColumn - 1 }, end: { line: edit.range.endLineNumber - 1, character: edit.range.endColumn - 1 } },
				rangeOffset: edit.rangeOffset, rangeLength: edit.rangeLength, text: edit.text,
			})),
		})));
		this.emit({ type: 'open', document: { ...extensionDocumentSnapshot(model) } });
	}

	private emit(event: JsonValue): void { for (const [, observer] of this.observers) observer.send(event); }
}

/** Each document subscription preserves commit order, including async extension callbacks. */
class DocumentObserver extends Disposable {
	private readonly controller = new AbortController();
	public readonly signal = this.controller.signal;
	private queue: Promise<unknown> = Promise.resolve();
	private pending = 0;

	constructor(private readonly invoke: (event: JsonValue) => Promise<JsonValue>, private readonly reportError: (error: unknown) => void) { super(); }

	public send(event: JsonValue): void {
		if (this.signal.aborted) return;
		// Retain every edit or stop the subscription: dropping edits corrupts extension document state.
		if (++this.pending > 64) {
			this.controller.abort();
			this.reportError(new Error('Extension document event queue exceeded 64 pending events'));
			return;
		}
		this.queue = this.queue.then(async () => {
			throwIfCancelled(this.signal);
			await this.invoke(event);
		}).catch(error => {
			// A callback failure is reported without suppressing later model commits.
			if (!this.signal.aborted) this.reportError(error);
		}).finally(() => { this.pending--; });
	}

	protected override disposeCore(): void { this.controller.abort(); super.disposeCore(); }
}

export function extensionDocumentSnapshot(model: ITextModel): ExtensionDocumentSnapshot {
	return { uri: model.uri.toString(), version: model.getVersionId(), languageId: model.getLanguageId(), text: model.getValue() };
}
