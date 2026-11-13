import { TaskQueue } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CodebaseSettingId, ICodebaseService, type CodebaseConfigurationSnapshot, type CodebaseModels } from '../../../../platform/codebase/common/codebaseService.js';
import type { ModelRef } from '../../../../platform/models/common/agentModels.js';
import { IContentSearchConfigurationService, type ContentSearchConfiguration } from '../../../../platform/search/common/search.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../../services/preferences/common/preferences.js';
import { IAppServerRemoteAgentService } from '../../../services/remote/common/appServerRemoteAgentService.js';

interface CodebaseSettingsSnapshot {
	readonly codebase: CodebaseConfigurationSnapshot;
	readonly grep: ContentSearchConfiguration;
}

type CodebaseSettingChange =
	| { readonly field: 'grep'; readonly value: boolean; }
	| { readonly field: 'embedding-model' | 'rerank-model'; readonly value: string; };

type CodebaseSettingsOperation =
	| { readonly kind: 'loading'; }
	| { readonly kind: 'saving'; readonly change: CodebaseSettingChange; };

/** Projects the connected App Server's profile settings and serializes edits to its shared revision. */
export class CodebaseSettingsModel extends Disposable implements SettingsSectionModel {
	public readonly categoryId = 'editor-suggestions';
	public readonly groupId = null;
	public readonly itemId = CodebaseSettingId;
	public readonly keywords = ['codebase', 'semantic search', 'embedding', 'rerank', 'grep.backend', 'tgrep', 'ripgrep', 'indexed search engine'];

	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private snapshot: CodebaseSettingsSnapshot | undefined;
	private writes = new TaskQueue();
	private visible = false;
	private connectionVersion = 0;
	private operation: CodebaseSettingsOperation | undefined;
	private needsRefresh = false;
	private message = '';

	constructor(
		@ICodebaseService private readonly codebase: ICodebaseService,
		@IContentSearchConfigurationService private readonly grep: IContentSearchConfigurationService,
		@IAppServerRemoteAgentService private readonly remote: IAppServerRemoteAgentService,
	) {
		super();
		this._register(codebase.onDidChangeConfig(() => {
			if (this.visible) { this.refresh(); }
		}));
		this._register(remote.onDidChangeConnection(() => {
			this.invalidateConnection();
			if (this.visible) { this.refresh(); }
		}));
		this._register(remote.onDidChangeConnectionState(state => {
			if (state !== 'connected') {
				this.invalidateConnection();
			} else if (this.visible && !this.snapshot && !this.operation) {
				this.refresh();
			}
		}));
	}

	public get title(): string {
		return localize({ bundle: 'ash.settings', key: 'codebase.title' }, 'Codebase');
	}

	public get description(): string {
		return localize({ bundle: 'ash.settings', key: 'codebase.description' }, 'Configure indexed Grep and models for semantic code search.');
	}

	public get help(): string {
		return localize({ bundle: 'ash.settings', key: 'codebase.help' }, 'Codebase settings\nUse Tab to reach each setting and Space to toggle repository indexing. Ash prepares the index in the background after you open an authorized repository. Enter model IDs as provider/model and press Enter or leave the field to save. Clear Embedding model to disable semantic search and clear its reranker. Changes save to the connected App Server profile. Press Escape to close help and return to the control.');
	}

	public get fields(): readonly SettingsSectionField[] {
		const config = this.snapshot?.codebase.codebase;
		const editable = !!this.snapshot;
		const saving = this.operation?.kind === 'saving' ? this.operation.change : undefined;
		return [
			{
				id: 'grep', kind: 'boolean',
				label: localize({ bundle: 'ash.settings', key: 'codebase.indexForGrep' }, 'Index repositories for instant Grep'),
				description: localize({ bundle: 'ash.settings', key: 'codebase.indexForGrepDescription' }, 'Automatically index repositories to speed up Grep searches. All index data is stored locally.'),
				value: saving?.field === 'grep' ? saving.value : this.snapshot?.grep.engine === 'tgrep', enabled: editable,
				setValue: value => this.save({ field: 'grep', value }),
			},
			{
				id: 'embedding-model', kind: 'text',
				label: localize({ bundle: 'ash.settings', key: 'codebase.embeddingModel' }, 'Embedding model'),
				description: localize({ bundle: 'ash.settings', key: 'codebase.embeddingDescription' }, 'Use a configured provider on the App Server device. Leave blank to disable semantic search.'),
				value: formatModel(config?.models?.embeddingModel), placeholder: 'provider/model', enabled: editable, commitOnChange: true,
				setValue: value => this.save({ field: 'embedding-model', value }),
			},
			{
				id: 'rerank-model', kind: 'text',
				label: localize({ bundle: 'ash.settings', key: 'codebase.rerankModel' }, 'Rerank model'),
				description: localize({ bundle: 'ash.settings', key: 'codebase.rerankDescription' }, 'Optional local model for reordering semantic matches.'),
				value: formatModel(config?.models?.rerankModel), placeholder: 'provider/model', enabled: editable && !!config?.models, commitOnChange: true,
				setValue: value => this.save({ field: 'rerank-model', value }),
			},
			{ id: 'status', kind: 'status', text: this.status },
		];
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		if (visible) { this.refresh(); }
	}

	private get status(): string {
		if (this.remote.connectionState !== 'connected') {
			return localize({ bundle: 'ash.settings', key: 'codebase.disconnected' }, 'Connect to App Server to edit Codebase settings.');
		}
		if (this.operation?.kind === 'loading') {
			return localize({ bundle: 'ash.settings', key: 'codebase.loading' }, 'Loading Codebase settings…');
		}
		if (this.operation?.kind === 'saving') {
			return localize({ bundle: 'ash.settings', key: 'codebase.saving' }, 'Saving Codebase settings…');
		}
		return this.message;
	}

	private invalidateConnection(): void {
		this.connectionVersion++;
		this.writes.clearPending();
		this.writes = new TaskQueue();
		this.operation = undefined;
		this.snapshot = undefined;
		this.message = '';
		this.changed.fire();
	}

	private refresh(): void {
		if (this.remote.connectionState !== 'connected') { return; }
		if (this.operation) {
			this.needsRefresh = true;
			return;
		}
		const version = this.connectionVersion;
		void this.writes.scheduleSkipIfCleared(() => {
			if (this.isCurrent(version)) {
				return this.run({ kind: 'loading' });
			}
		});
	}

	private save(change: CodebaseSettingChange): void {
		if (!this.visible || !this.snapshot) { return; }
		const version = this.connectionVersion;
		void this.writes.scheduleSkipIfCleared(() => {
			if (this.isCurrent(version) && this.snapshot) {
				return this.run({ kind: 'saving', change });
			}
		});
	}

	private async run(operation: CodebaseSettingsOperation): Promise<void> {
		const version = this.connectionVersion;
		this.operation = operation;
		this.message = '';
		this.changed.fire();
		if (!this.isCurrent(version)) { return; }
		if (operation.kind === 'saving' && this.snapshot) {
			try {
				await this.applyChange(this.snapshot, operation.change);
			} catch {
				if (!this.isCurrent(version)) { return; }
				this.message = localize({ bundle: 'ash.settings', key: 'codebase.saveFailed' }, 'Could not save Codebase settings. Try the change again.');
			}
		}
		if (!this.isCurrent(version)) { return; }
		do {
			this.needsRefresh = false;
			try {
				const [codebase, grep] = await Promise.all([this.codebase.readConfig(), this.grep.read()]);
				if (!this.isCurrent(version)) { return; }
				this.snapshot = { codebase, grep };
			} catch {
				if (!this.isCurrent(version)) { return; }
				this.snapshot = undefined;
			}
		} while (this.needsRefresh);
		if (!this.snapshot) {
			this.message = localize({ bundle: 'ash.settings', key: 'codebase.readFailed' }, 'Could not load Codebase settings. Reopen settings to try again.');
		}
		this.operation = undefined;
		this.changed.fire();
	}

	private async applyChange(snapshot: CodebaseSettingsSnapshot, change: CodebaseSettingChange): Promise<void> {
		if (change.field === 'grep') {
			const engine = change.value ? 'tgrep' : 'ripgrep';
			if (engine !== snapshot.grep.engine) {
				await this.grep.configure(engine, snapshot.grep.revision);
			}
			return;
		}
		const { models, automaticContext } = snapshot.codebase.codebase;
		const value = change.value.trim();
		const saved = change.field === 'embedding-model' ? models?.embeddingModel : models?.rerankModel;
		if (value === formatModel(saved)) { return; }
		const model = modelReference(value);
		if (value && !model) {
			this.message = localize({ bundle: 'ash.settings', key: 'codebase.invalidModel' }, 'Enter model IDs in provider/model format.');
			return;
		}
		let next: CodebaseModels | undefined;
		if (change.field === 'embedding-model') {
			next = model ? { embeddingModel: model, rerankModel: models?.rerankModel } : undefined;
		} else if (models) {
			next = { embeddingModel: models.embeddingModel, rerankModel: model };
		} else {
			return;
		}
		// The backend updates the entire Codebase preference, including any existing opt-in.
		await this.codebase.configure(next, automaticContext, snapshot.codebase.revision);
	}

	private isCurrent(version: number): boolean {
		return !this.isDisposed && version === this.connectionVersion;
	}
}

function formatModel(model: ModelRef | null | undefined): string {
	return model ? `${model.provider}/${model.model}` : '';
}

function modelReference(value: string): ModelRef | undefined {
	const separator = value.indexOf('/');
	if (separator < 1) { return undefined; }
	const provider = value.slice(0, separator).trim();
	const model = value.slice(separator + 1).trim();
	return provider && model ? { provider, model } : undefined;
}
