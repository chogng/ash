import { DeferredPromise, raceCancellationError } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, type IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import {
	ILanguageServerService,
	type LanguageServerState,
} from '../../../../platform/language/common/languageServerService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import {
	ILanguageServerLifecycleService,
	LanguageServerLifecycleConfiguration,
} from '../common/languageServerLifecycleService.js';

interface Server {
	readonly dirId: string;
	readonly serverId: string;
	languages: readonly string[];
	state: LanguageServerState['type'];
	capabilitiesCurrent: boolean;
	readonly progress: Set<string>;
	requests: number;
	timer?: ReturnType<typeof setTimeout>;
	stopping?: Promise<void>;
	waking?: Promise<void>;
	ready?: DeferredPromise<void>;
}

/** Keeps syntax/editor lifetimes independent from optional language-server processes. */
export class AppServerLanguageLifecycleService extends Disposable implements ILanguageServerLifecycleService {
	private readonly entries = new Map<string, Server>();
	private readonly editorListeners = this._register(new DisposableMap<ICodeEditor, IDisposable>());
	private started = false;
	private alive = true;

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IModelService models: IModelService,
		@ICodeEditorService private readonly editors: ICodeEditorService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ILanguageServerService private readonly servers: ILanguageServerService,
		@IServerEventApi events: IServerEventApi,
		@ILogService private readonly log: ILogService,
	) {
		super();
		const subscription = events.subscribe(event => {
			if (
				event.method !== 'language/serverCapabilities' &&
				event.method !== 'language/serverState' &&
				event.method !== 'language/serverProgress'
			)
				return;
			const dirId = event.params.dirId ?? this.workspace.getWorkspace().folders[0]?.id;
			if (!dirId) return;
			const key = `${dirId}:${event.params.server}`;
			let entry = this.entries.get(key);
			if (!entry) {
				entry = {
					dirId,
					serverId: event.params.server,
					languages: [],
					state: 'starting',
					capabilitiesCurrent: false,
					progress: new Set(),
					requests: 0,
				};
				this.entries.set(key, entry);
			}
			if (event.method === 'language/serverCapabilities') {
				entry.languages = event.params.languageIds;
				entry.capabilitiesCurrent = true;
			}
			if (event.method === 'language/serverProgress') {
				if (event.params.done) entry.progress.delete(event.params.token);
				else entry.progress.add(event.params.token);
			}
			if (event.method === 'language/serverState') {
				entry.state = event.params.state.type;
				if (entry.state === 'starting' || entry.state === 'stopped') entry.capabilitiesCurrent = false;
				if (entry.state === 'failed' || entry.state === 'crashLoop')
					entry.ready?.error(new Error('Language server could not resume'));
				if (entry.state === 'idle' || entry.state === 'stopped') entry.progress.clear();
			}
			// Ready precedes the new incarnation's capability notification on the wire.
			if (entry.state === 'ready' && entry.capabilitiesCurrent) entry.ready?.complete();
			this.refresh(entry);
		});
		this._register(toDisposable(() => subscription.dispose()));
		this._register(models.onModelLanguageChanged(() => this.refreshAll()));
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('languageServers')) {
					for (const entry of this.entries.values()) this.cancelTimer(entry);
					this.refreshAll();
				}
			}),
		);
		this._register(workspace.onDidChangeWorkspace(() => this.clear()));
		this._register(
			toDisposable(() => {
				this.alive = false;
				this.clear();
			}),
		);
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		// CodeEditorService depends on EditorParts. The host calls start only after its
		// synchronous service graph and configuration layers have finished construction.
		const attach = (editor: ICodeEditor): void => {
			this.editorListeners.set(
				editor,
				editor.onDidChangeModel(() => this.refreshAll()),
			);
			this.refreshAll();
		};
		for (const editor of this.editors.listCodeEditors()) attach(editor);
		this._register(this.editors.onCodeEditorAdd(attach));
		this._register(
			this.editors.onCodeEditorRemove(editor => {
				this.editorListeners.deleteAndDispose(editor);
				queueMicrotask(() => {
					if (this.alive) this.refreshAll();
				});
			}),
		);
		this.refreshAll();
	}

	async withActivity<T>(
		document: { readonly dirId?: string; readonly languageId: string },
		signal: AbortSignal | undefined,
		operation: () => Promise<T>,
	): Promise<T> {
		const dirId = document.dirId ?? this.workspace.getWorkspace().folders[0]?.id;
		const entry = [...this.entries.values()].find(
			value => value.dirId === dirId && value.languages.includes(document.languageId),
		);
		if (!entry) return operation();
		entry.requests++;
		this.cancelTimer(entry);
		try {
			const ready = this.activate(entry);
			// Cancelling a UI request does not discard another caller's shared activation.
			if (signal) await raceCancellationError(ready, signal, 'Language server activation cancelled');
			else await ready;
			signal?.throwIfAborted();
			return await operation();
		} finally {
			entry.requests--;
			if (entry.state === 'ready') this.refresh(entry);
		}
	}

	private refreshAll(): void {
		for (const entry of this.entries.values()) this.refresh(entry);
	}

	private hasOpenModel(entry: Server): boolean {
		// A closed resource can retain a cached TextModel for undo or working-copy reuse.
		return this.editors.listCodeEditors().some(editor => {
			const model = editor.getModel();
			return (
				model &&
				entry.languages.includes(model.getLanguageId()) &&
				this.workspace.getWorkspaceFolder(model.uri)?.id === entry.dirId
			);
		});
	}

	private refresh(entry: Server): void {
		if (!this.alive || !this.started || this.entries.get(`${entry.dirId}:${entry.serverId}`) !== entry) return;
		const enabled = this.configuration.getValue<boolean>(LanguageServerLifecycleConfiguration.autoSuspend);
		if (this.hasOpenModel(entry) || !enabled) {
			this.cancelTimer(entry);
			if (entry.state === 'idle' || entry.stopping)
				void this.activate(entry).catch(error => this.log.warn('Language server resume failed', error));
			return;
		}
		if (entry.state !== 'ready' || entry.requests || entry.progress.size || entry.stopping || entry.waking) {
			this.cancelTimer(entry);
			return;
		}
		if (entry.timer !== undefined) return;
		entry.timer = setTimeout(
			() => {
				entry.timer = undefined;
				if (
					this.hasOpenModel(entry) ||
					entry.requests ||
					entry.progress.size ||
					!this.configuration.getValue<boolean>(LanguageServerLifecycleConfiguration.autoSuspend)
				)
					return;
				entry.stopping = this.servers.control({
					action: 'suspend',
					dirId: this.wireId(entry),
					serverId: entry.serverId,
				});
				void entry.stopping
					.catch(error => this.log.warn('Idle language server release failed', error))
					.finally(() => {
						entry.stopping = undefined;
						this.refresh(entry);
					});
			},
			this.configuration.getValue<number>(LanguageServerLifecycleConfiguration.idleTimeoutMinutes) * 60_000,
		);
	}

	private activate(entry: Server): Promise<void> {
		if (entry.waking) return entry.waking;
		if (!entry.stopping && entry.state !== 'idle') return Promise.resolve();
		entry.waking = Promise.resolve()
			.then(async () => {
				await entry.stopping;
				if (
					!this.alive ||
					this.entries.get(`${entry.dirId}:${entry.serverId}`) !== entry ||
					entry.state !== 'idle'
				)
					return;
				const ready = (entry.ready = new DeferredPromise<void>());
				const timeout = setTimeout(() => ready.error(new Error('Language server resume timed out')), 30_000);
				try {
					await Promise.all([
						this.servers.control({ action: 'resume', dirId: this.wireId(entry), serverId: entry.serverId }),
						ready.p,
					]);
				} finally {
					clearTimeout(timeout);
					entry.ready = undefined;
				}
			})
			.finally(() => {
				entry.waking = undefined;
				// A failed activation waits for new demand instead of retrying on its own completion.
				if (entry.state === 'ready') this.refresh(entry);
			});
		return entry.waking;
	}

	private wireId(entry: Server): string | undefined {
		return this.workspace.getWorkspace().folders.length > 1 ? entry.dirId : undefined;
	}
	private cancelTimer(entry: Server): void {
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		entry.timer = undefined;
	}
	private clear(): void {
		for (const entry of this.entries.values()) {
			this.cancelTimer(entry);
			entry.ready?.error(new Error('Language workspace closed'));
		}
		this.entries.clear();
	}
}
