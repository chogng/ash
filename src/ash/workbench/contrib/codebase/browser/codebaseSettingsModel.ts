import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CodebaseSettingId, ICodebaseService, type CodebaseAutomaticContext, type CodebaseConfigurationSnapshot } from '../../../../platform/codebase/common/codebaseService.js';
import type { ModelRef } from '../../../../platform/models/common/agentModels.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../../services/preferences/common/preferences.js';
import { IAppServerRemoteAgentService } from '../../../services/remote/common/appServerRemoteAgentService.js';

interface CodebaseDraft {
	readonly automaticContext: CodebaseAutomaticContext;
	readonly embedding: string;
	readonly rerank: string;
}

/** The section keeps an editable draft of the connected App Server's profile configuration. */
export class CodebaseSettingsModel extends Disposable implements SettingsSectionModel {
	readonly categoryId = 'editor-suggestions';
	readonly groupId = null;
	readonly itemId = CodebaseSettingId;
	readonly keywords = ['codebase', 'semantic search', 'embedding', 'rerank'];

	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private snapshot: CodebaseConfigurationSnapshot | undefined;
	private draft = draftFromSnapshot();
	private visible = false;
	private request = 0;
	private operation: 'loading' | 'saving' | undefined;
	private message = '';

	constructor(
		@ICodebaseService private readonly codebase: ICodebaseService,
		@IAppServerRemoteAgentService private readonly remote: IAppServerRemoteAgentService,
	) {
		super();
		this._register(codebase.onDidChangeConfig(() => {
			if (this.visible && this.operation !== 'saving' && (!this.isDirty || this.operation === 'loading')) {
				void this.refresh();
			}
		}));
		this._register(remote.onDidChangeConnection(() => this.handleConnectionChange()));
		this._register(remote.onDidChangeConnectionState(state => {
			if (state !== 'connected') {
				this.handleConnectionChange();
			} else if (this.visible && !this.snapshot && !this.operation) {
				void this.refresh();
			}
		}));
	}

	get title(): string {
		return localize({ bundle: 'ash.settings', key: 'codebase.title' }, 'Codebase');
	}

	get description(): string {
		return localize({ bundle: 'ash.settings', key: 'codebase.description' }, 'Configure automatic code context and local models for semantic code search.');
	}

	get help(): string {
		return localize({ bundle: 'ash.settings', key: 'codebase.help' }, 'Codebase settings\nUse Tab to reach Automatic context, Embedding model, Rerank model, Save, and Refresh. Press Space to toggle Automatic context. Enter model IDs as provider/model. Clear Embedding model to disable semantic search and clear its reranker. Save applies all three values to the connected App Server profile. Refresh reloads the saved values and discards edits. Escape closes help and returns focus.');
	}

	get fields(): readonly SettingsSectionField[] {
		const canRefresh = this.remote.connectionState === 'connected' && !this.operation;
		const editable = canRefresh && !!this.snapshot;
		return [
			{
				id: 'automatic-context', kind: 'boolean',
				label: localize({ bundle: 'ash.settings', key: 'codebase.automaticContext' }, 'Automatic context'),
				description: localize({ bundle: 'ash.settings', key: 'codebase.automaticContextDescription' }, 'Add relevant code to the first model call of each turn.'),
				value: this.draft.automaticContext === 'firstInvocation', enabled: editable,
				setValue: enabled => this.edit({ automaticContext: enabled ? 'firstInvocation' : 'off' }),
			},
			{
				id: 'embedding-model', kind: 'text',
				label: localize({ bundle: 'ash.settings', key: 'codebase.embeddingModel' }, 'Embedding model'),
				description: localize({ bundle: 'ash.settings', key: 'codebase.embeddingDescription' }, 'Use a configured provider on the App Server device. Leave blank to disable semantic search.'),
				value: this.draft.embedding, placeholder: 'provider/model', enabled: editable,
				setValue: embedding => this.edit({ embedding }),
			},
			{
				id: 'rerank-model', kind: 'text',
				label: localize({ bundle: 'ash.settings', key: 'codebase.rerankModel' }, 'Rerank model'),
				description: localize({ bundle: 'ash.settings', key: 'codebase.rerankDescription' }, 'Optional local model for reordering semantic matches.'),
				value: this.draft.rerank, placeholder: 'provider/model', enabled: editable && !!this.draft.embedding.trim(),
				setValue: rerank => this.edit({ rerank }),
			},
			{ id: 'save', kind: 'action', label: localize({ bundle: 'ash.settings', key: 'codebase.save' }, 'Save Codebase settings'), enabled: editable && this.isDirty, run: () => this.save() },
			{ id: 'refresh', kind: 'action', label: localize({ bundle: 'ash.settings', key: 'codebase.refresh' }, 'Refresh Codebase settings'), enabled: canRefresh, run: () => this.refresh() },
			{ id: 'status', kind: 'status', text: this.status },
		];
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		this.handleConnectionChange();
	}

	private get isDirty(): boolean {
		const saved = draftFromSnapshot(this.snapshot);
		return this.draft.automaticContext !== saved.automaticContext
			|| this.draft.embedding.trim() !== saved.embedding
			|| this.draft.rerank.trim() !== saved.rerank;
	}

	private get status(): string {
		if (this.remote.connectionState !== 'connected') {
			return localize({ bundle: 'ash.settings', key: 'codebase.disconnected' }, 'Connect to App Server to edit Codebase settings.');
		}
		if (this.operation === 'loading') {
			return localize({ bundle: 'ash.settings', key: 'codebase.loading' }, 'Loading Codebase settings…');
		}
		if (this.operation === 'saving') {
			return localize({ bundle: 'ash.settings', key: 'codebase.saving' }, 'Saving Codebase settings…');
		}
		return this.message;
	}

	private edit(changes: Partial<CodebaseDraft>): void {
		this.draft = { ...this.draft, ...changes };
		this.message = '';
		this.changed.fire();
	}

	private handleConnectionChange(): void {
		this.request++;
		this.operation = undefined;
		this.snapshot = undefined;
		this.draft = draftFromSnapshot();
		this.message = '';
		if (this.visible) { void this.refresh(); }
	}

	private async refresh(): Promise<void> {
		if (!this.visible || this.remote.connectionState !== 'connected') {
			this.changed.fire();
			return;
		}
		const request = ++this.request;
		this.operation = 'loading';
		this.message = '';
		this.changed.fire();
		try {
			const snapshot = await this.codebase.readConfig();
			if (!this.isCurrent(request)) { return; }
			this.snapshot = snapshot;
			this.draft = draftFromSnapshot(snapshot);
		} catch {
			if (!this.isCurrent(request)) { return; }
			this.snapshot = undefined;
			this.message = localize({ bundle: 'ash.settings', key: 'codebase.readFailed' }, 'Could not load Codebase settings. Refresh to try again.');
		} finally {
			if (this.isCurrent(request)) {
				this.operation = undefined;
				this.changed.fire();
			}
		}
	}

	private async save(): Promise<void> {
		const snapshot = this.snapshot;
		if (!this.visible || !snapshot || this.operation || !this.isDirty || this.remote.connectionState !== 'connected') { return; }
		const embedding = this.draft.embedding.trim();
		const rerank = this.draft.rerank.trim();
		const embeddingModel = modelReference(embedding, snapshot.codebase.models?.embeddingModel);
		const rerankModel = modelReference(rerank, snapshot.codebase.models?.rerankModel);
		if (embedding && (!embeddingModel || (rerank && !rerankModel))) {
			this.message = localize({ bundle: 'ash.settings', key: 'codebase.invalidModel' }, 'Enter model IDs in provider/model format.');
			this.changed.fire();
			return;
		}
		const request = ++this.request;
		this.operation = 'saving';
		this.changed.fire();
		try {
			await this.codebase.configure(embeddingModel ? { embeddingModel, rerankModel } : undefined, this.draft.automaticContext, snapshot.revision);
			if (this.isCurrent(request)) { await this.refresh(); }
		} catch {
			if (!this.isCurrent(request)) { return; }
			this.message = localize({ bundle: 'ash.settings', key: 'codebase.saveFailed' }, 'Could not save Codebase settings. Refresh to load the latest values.');
		} finally {
			if (this.isCurrent(request)) {
				this.operation = undefined;
				this.changed.fire();
			}
		}
	}

	private isCurrent(request: number): boolean {
		return !this.isDisposed && this.visible && request === this.request;
	}
}

function draftFromSnapshot(snapshot?: CodebaseConfigurationSnapshot): CodebaseDraft {
	return {
		automaticContext: snapshot?.codebase.automaticContext ?? 'off',
		embedding: formatModel(snapshot?.codebase.models?.embeddingModel),
		rerank: formatModel(snapshot?.codebase.models?.rerankModel),
	};
}

function formatModel(model: ModelRef | null | undefined): string {
	return model ? `${model.provider}/${model.model}` : '';
}

function modelReference(value: string, saved: ModelRef | null | undefined): ModelRef | undefined {
	if (saved && formatModel(saved) === value) { return saved; }
	const separator = value.indexOf('/');
	if (separator < 1) { return undefined; }
	const provider = value.slice(0, separator).trim();
	const model = value.slice(separator + 1).trim();
	return provider && model ? { provider, model } : undefined;
}
