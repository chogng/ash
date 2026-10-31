import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAgentModelsService, type AgentModelDefaults, type AgentModelDefaultsUpdate } from '../../../../platform/agentHost/common/agentModels.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../services/chat/common/modelCatalog.js';
import type { SettingsSectionField, SettingsSectionModel } from './settingsTreeModels.js';

/** Edits a backend task default without changing the conversation model. */
export class AgentTaskModelSettingsModel extends Disposable implements SettingsSectionModel {
	public readonly categoryId = 'agents';
	public readonly groupId = null;
	public get itemId(): string { return this.kind === 'codeReviewModel' ? 'chat.codeReview' : 'chat.commitMessage'; }
	public get keywords(): readonly string[] { return this.kind === 'codeReviewModel' ? ['review', 'model', 'code review', 'find issues'] : ['commit', 'model', 'commit message', 'git']; }
	public get title(): string {
		if (this.kind === 'commitMessageModel') {
			return localize('commitMessage.settings.title', 'Commit messages');
		}
		return localize('codeReview.settings.title', 'Review model');
	}
	public get description(): string {
		if (this.kind === 'commitMessageModel') {
			return localize('commitMessage.settings.description', 'Use the model from the conversation that produced the changes, or choose a dedicated model. Source changes are sent only for directories you have authorized. Changing the model clears those authorizations.');
		}
		return localize('codeReview.settings.description', 'Choose a dedicated model for Find Issues and code reviews, or follow the current conversation’s model.');
	}
	public get help(): string {
		if (this.kind === 'commitMessageModel') {
			return localize('commitMessage.settings.help', 'Commit message settings\nUse Tab to reach Automatically generate commit messages and Space to toggle it. Turning it off keeps the selected model. Use Tab to reach Model. Press Enter or Space to open it, use the arrow keys to select a model, and press Enter to save immediately. Inherit conversation model uses the model from the conversation turn that produced the changes, even if you later change the conversation model. If that model is unavailable, choose a dedicated model. Changing the selection clears directory authorizations; authorize the resolved model before its source changes can be sent. Models and connections are managed in Models. Escape closes this help and returns focus.');
		}
		return localize('codeReview.settings.help', 'Review model settings\nUse Tab to reach the model selector. Press Enter or Space to open it, use the arrow keys to select a model, and press Enter to save immediately. Follow Current Model clears the code-review override. The selection applies to future code reviews, including current, staged, branch and custom reviews from Find Issues. Models and connections are managed in Models. An unavailable saved model remains visible; choose an available model before reviewing. Escape closes this help and returns focus.');
	}
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private snapshot: AgentModelDefaults | undefined;
	private models: readonly ModelCatalogEntry[] = [];
	private visible = false;
	private busy = false;
	private revision = 0;
	private reloadRequested = false;
	private message = '';

	constructor(
		private readonly kind: 'codeReviewModel' | 'commitMessageModel',
		@IAgentModelsService private readonly modelApi: IAgentModelsService,
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
	) {
		super();
		this._register(languageModels.onDidChangeModels(() => {
			if (!this.visible) { return; }
			if (this.busy) { this.reloadRequested = true; }
			else { void this.load(); }
		}));
	}

	public get fields(): readonly SettingsSectionField[] {
		const selected = this.snapshot?.[this.kind];
		const options = [
			{ value: '', label: this.kind === 'commitMessageModel' ? localize('commitMessage.settings.inherit', 'Inherit conversation model') : localize('codeReview.settings.follow', 'Follow Current Model') },
			...this.models.filter(entry => this.languageModels.isModelVisible(entry.model)).map(entry => ({ value: modelRefIdentity(entry.model), label: entry.displayName })),
		];
		const value = selected ? modelRefIdentity(selected) : '';
		if (selected && !options.some(option => option.value === value)) {
			options.push({ value, label: localize('codeReview.settings.unavailable', '{0} (unavailable)', `${selected.provider}/${selected.model}`) });
		}
		const fields: SettingsSectionField[] = [
			{
				id: this.kind === 'codeReviewModel' ? 'code-review-model' : 'commit-message-model', kind: 'select', label: localize('codeReview.settings.selector', 'Model'), value, options, enabled: !!this.snapshot && !this.busy, setValue: value => {
					const model = this.models.find(entry => modelRefIdentity(entry.model) === value)?.model;
					if (value && !model) { return; }
					void this.save({ [this.kind]: model ?? null });
				}
			},
			{ id: this.kind === 'codeReviewModel' ? 'code-review-status' : 'commit-message-status', kind: 'status', text: this.message },
		];
		if (this.kind === 'commitMessageModel') {
			fields.unshift({
				id: 'commit-message-enabled', kind: 'boolean',
				label: localize('commitMessage.settings.enabled', 'Automatically generate commit messages'),
				value: this.snapshot?.commitMessageEnabled ?? false, enabled: !!this.snapshot && !this.busy,
				setValue: enabled => { void this.save({ commitMessageEnabled: enabled }); },
			});
		}
		return fields;
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		this.revision++;
		this.reloadRequested = false;
		this.busy = false;
		if (visible) { void this.load(); }
	}

	private async load(): Promise<void> {
		const revision = ++this.revision;
		this.busy = true;
		this.message = this.kind === 'commitMessageModel'
			? localize('commitMessage.settings.loading', 'Loading commit message settings...')
			: localize('codeReview.settings.loading', 'Loading review model...');
		this.changed.fire();
		try {
			const [snapshot, models] = await Promise.all([this.modelApi.readDefaults(), this.languageModels.listModelCatalog()]);
			if (!this.isCurrent(revision)) { return; }
			this.snapshot = snapshot;
			this.models = models;
			this.message = '';
		} catch (error) {
			if (this.isCurrent(revision)) {
				this.message = this.kind === 'commitMessageModel'
					? localize('commitMessage.settings.loadFailed', 'Could not load commit message settings: {0}', String(error))
					: localize('codeReview.settings.loadFailed', 'Could not load review model: {0}', String(error));
			}
		} finally {
			this.finish(revision);
		}
	}

	private async save(update: AgentModelDefaultsUpdate): Promise<void> {
		if (!this.visible || this.busy || !this.snapshot) { return; }
		const revision = ++this.revision;
		this.busy = true;
		this.message = '';
		this.changed.fire();
		try {
			// Other task selectors edit the same backend document. Read its latest revision before patching only this task.
			const current = await this.modelApi.readDefaults();
			if (!this.isCurrent(revision)) { return; }
			await this.modelApi.configureDefaults(update, current.revision);
			if (!this.isCurrent(revision)) { return; }
			const snapshot = await this.modelApi.readDefaults();
			if (!this.isCurrent(revision)) { return; }
			this.snapshot = snapshot;
			this.message = this.kind === 'commitMessageModel'
				? localize('commitMessage.settings.saved', 'Commit message settings saved.')
				: localize('codeReview.settings.saved', 'Review model saved.');
		} catch (error) {
			if (this.isCurrent(revision)) {
				this.message = this.kind === 'commitMessageModel'
					? localize('commitMessage.settings.saveFailed', 'Could not save commit message settings: {0}', String(error))
					: localize('codeReview.settings.saveFailed', 'Could not save review model: {0}', String(error));
			}
		} finally {
			this.finish(revision);
		}
	}

	private isCurrent(revision: number): boolean { return !this.isDisposed && this.visible && revision === this.revision; }

	private finish(revision: number): void {
		if (!this.isCurrent(revision)) { return; }
		this.busy = false;
		this.changed.fire();
		if (this.reloadRequested) {
			this.reloadRequested = false;
			void this.load();
		}
	}
}
