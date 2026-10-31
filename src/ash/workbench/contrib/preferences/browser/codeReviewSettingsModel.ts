import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAgentModelsService, type AgentModelDefaults, type ModelRef } from '../../../../platform/agentHost/common/agentModels.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../services/chat/common/modelCatalog.js';
import type { SettingsSectionField, SettingsSectionModel } from './settingsTreeModels.js';

/** Edits the backend's code-review default; it never changes the chat model selection. */
export class CodeReviewSettingsModel extends Disposable implements SettingsSectionModel {
	public readonly categoryId = 'agents';
	public readonly groupId = null;
	public readonly itemId = 'chat.codeReview';
	public readonly keywords = ['review', 'model', 'code review', 'find issues'];
	public get title(): string { return localize('codeReview.settings.title', 'Review model'); }
	public get description(): string { return localize('codeReview.settings.description', 'Choose a dedicated model for Find Issues and code reviews, or follow the current conversation’s model.'); }
	public get help(): string { return localize('codeReview.settings.help', 'Review model settings\nUse Tab to reach the model selector. Press Enter or Space to open it, use the arrow keys to select a model, and press Enter to save immediately. Follow Current Model clears the code-review override. The selection applies to future code reviews, including current, staged, branch and custom reviews from Find Issues. Models and connections are managed in Models. An unavailable saved model remains visible; choose an available model before reviewing. Escape closes this help and returns focus.'); }
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
		const selected = this.snapshot?.codeReviewModel;
		const options = [
			{ value: '', label: localize('codeReview.settings.follow', 'Follow Current Model') },
			...this.models.filter(entry => this.languageModels.isModelVisible(entry.model)).map(entry => ({ value: modelRefIdentity(entry.model), label: entry.displayName })),
		];
		const value = selected ? modelRefIdentity(selected) : '';
		if (selected && !options.some(option => option.value === value)) {
			options.push({ value, label: localize('codeReview.settings.unavailable', '{0} (unavailable)', `${selected.provider}/${selected.model}`) });
		}
		return [
			{
				id: 'code-review-model', kind: 'select', label: localize('codeReview.settings.selector', 'Model'), value, options, enabled: !!this.snapshot && !this.busy, setValue: value => {
					const model = this.models.find(entry => modelRefIdentity(entry.model) === value)?.model;
					if (value && !model) { return; }
					void this.save(model ?? null);
				}
			},
			{ id: 'code-review-status', kind: 'status', text: this.message },
		];
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
		this.message = localize('codeReview.settings.loading', 'Loading review model...');
		this.changed.fire();
		try {
			const [snapshot, models] = await Promise.all([this.modelApi.readDefaults(), this.languageModels.listModelCatalog()]);
			if (!this.isCurrent(revision)) { return; }
			this.snapshot = snapshot;
			this.models = models;
			this.message = '';
		} catch (error) {
			if (this.isCurrent(revision)) { this.message = localize('codeReview.settings.loadFailed', 'Could not load review model: {0}', String(error)); }
		} finally {
			this.finish(revision);
		}
	}

	private async save(model: ModelRef | null): Promise<void> {
		if (!this.visible || this.busy || !this.snapshot) { return; }
		const revision = ++this.revision;
		this.busy = true;
		this.message = '';
		this.changed.fire();
		try {
			await this.modelApi.configureDefaults({ codeReviewModel: model }, this.snapshot.revision);
			if (!this.isCurrent(revision)) { return; }
			const snapshot = await this.modelApi.readDefaults();
			if (!this.isCurrent(revision)) { return; }
			this.snapshot = snapshot;
			this.message = localize('codeReview.settings.saved', 'Review model saved.');
		} catch (error) {
			if (this.isCurrent(revision)) { this.message = localize('codeReview.settings.saveFailed', 'Could not save review model: {0}', String(error)); }
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
