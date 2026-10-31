import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { updateAdvisorConfig } from '../../../services/chat/common/advisor.js';
import { IChatService, type AdvisorConfig } from '../../../services/chat/common/chatService.js';
import { ModelPurpose, modelsRecommendedFor, modelRefIdentity, type ModelCatalogEntry, type ModelReasoningEffort } from '../../../services/chat/common/modelCatalog.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../../services/preferences/common/preferences.js';

/** Advisor settings data; each host supplies the shared Preferences renderer. */
export class AdvisorSettingsModel extends Disposable implements SettingsSectionModel {
	readonly categoryId = 'agents';
	readonly groupId = null;
	readonly itemId = 'chat.advisor';
	get title(): string { return localize('advisor.settings.title', 'Advisor'); }
	get description(): string { return localize('advisor.settings.description', 'Choose a higher-intelligence model to provide strategic guidance while the executor continues with the task.'); }
	get keywords(): readonly string[] { return ['advisor', 'model', 'second opinion', localize('advisor.settings.model', 'Advisor model')]; }
	get help(): string { return localize('advisor.settings.help', 'Advisor settings\nUse Tab to reach Advisor model. Press Enter or Space to open the list, use arrow keys to choose an option, and press Enter to save. Inherit from chat uses the current chat model and reasoning effort. Disable turns Advisor off and keeps the saved selection. Below the divider, choose a model and reasoning effort from the visible models recommended for Advisor. Escape closes the list or help and returns focus.'); }
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private models: readonly ModelCatalogEntry[] = [];
	private savedAdvisor: AdvisorConfig | null = null;
	private loaded = false;
	private working = false;
	private visible = false;
	private version = 0;
	private reloadRequested = false;
	private message = '';

	constructor(
		@IChatService private readonly chat: IChatService,
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
	) {
		super();
		this._register(toDisposable(() => { this.version++; }));
		this._register(languageModels.onDidChangeModels(() => {
			if (!this.visible) { return; }
			if (this.working) { this.reloadRequested = true; }
			else { void this.load(); }
		}));
	}

	get fields(): readonly SettingsSectionField[] {
		const advisor = this.savedAdvisor;
		const choices = this.modelChoices();
		const options = [
			{ value: 'inherit', label: localize('advisor.settings.inherit', 'Inherit from chat') },
			{ value: '', label: localize('advisor.settings.disabled', 'Disable') },
			...choices.map((choice, index) => ({ value: choice.value, label: choice.label, separatorBefore: index === 0 })),
		];
		let value = '';
		if (advisor?.enabled) {
			value = advisor.model ? modelChoiceValue(advisor.model, advisor.reasoningEffort ?? undefined) : 'inherit';
		}
		return [{
			id: 'advisor-model', kind: 'select', label: localize('advisor.settings.model', 'Advisor model'),
			description: this.description, value, options, enabled: this.loaded && !this.working,
			setValue: value => this.selectModel(value),
		}, { id: 'advisor-status', kind: 'status', text: this.message }];
	}

	private modelChoices(): readonly { value: string; label: string; entry: Pick<ModelCatalogEntry, 'model' | 'supportedReasoningEfforts'>; effort: ModelReasoningEffort | undefined; }[] {
		const entries = [...modelsRecommendedFor(this.models, ModelPurpose.Advisor).filter(entry => this.languageModels.isModelVisible(entry.model))];
		const saved = this.savedAdvisor;
		const savedModel = saved?.model;
		// Recommendation and visibility updates never replace a saved selection.
		if (savedModel && !entries.some(entry => modelRefIdentity(entry.model) === modelRefIdentity(savedModel))) {
			entries.push(this.models.find(entry => modelRefIdentity(entry.model) === modelRefIdentity(savedModel)) ?? {
				model: savedModel, displayName: `${savedModel.provider}/${savedModel.model}`, longContext: null,
			});
		}
		return entries.flatMap(entry => {
			const efforts: (ModelReasoningEffort | undefined)[] = [undefined, ...(entry.supportedReasoningEfforts ?? []).map(option => option.effort)];
			if (saved?.model && modelRefIdentity(saved.model) === modelRefIdentity(entry.model) && saved.reasoningEffort && !efforts.includes(saved.reasoningEffort)) {
				efforts.push(saved.reasoningEffort);
			}
			return efforts.map(effort => ({
				value: modelChoiceValue(entry.model, effort),
				label: localize('advisor.settings.modelEffort', '{0} · {1}', entry.displayName, effort === undefined && entry.defaultReasoningEffort
					? localize('advisor.settings.defaultEffort', '{0} (Default)', effortLabel(entry.defaultReasoningEffort)) : effortLabel(effort)),
				entry, effort,
			}));
		});
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		if (visible) { void this.load(); }
		else {
			this.version++;
			this.working = false;
			this.loaded = false;
			this.reloadRequested = false;
		}
	}

	private async load(): Promise<void> {
		const version = ++this.version;
		this.working = true;
		this.message = localize('advisor.settings.loading', 'Loading Advisor settings…');
		this.changed.fire();
		try {
			const [models, advisor] = await Promise.all([this.languageModels.listModelCatalog(), this.chat.readAdvisorDefault()]);
			if (!this.isCurrent(version)) { return; }
			this.models = models;
			this.savedAdvisor = advisor;
			this.loaded = true;
			this.message = '';
		} catch (error) {
			if (this.isCurrent(version)) { this.message = localize('advisor.settings.loadFailed', 'Could not load Advisor settings: {0}', String(error)); }
		} finally {
			if (this.isCurrent(version)) { this.finish(); }
		}
	}

	private selectModel(value: string): void {
		if (!this.visible || !this.loaded || this.working) { return; }
		if (value === 'inherit') {
			void this.save(updateAdvisorConfig(this.savedAdvisor, { type: 'inherit' }));
			return;
		}
		if (!value) {
			void this.save(updateAdvisorConfig(this.savedAdvisor, { type: 'setEnabled', enabled: false }));
			return;
		}
		const selected = this.modelChoices().find(choice => choice.value === value);
		if (selected) { void this.save(updateAdvisorConfig(this.savedAdvisor, { type: 'selectModel', model: selected.entry, reasoningEffort: selected.effort ?? null })); }
	}

	private async save(next: AdvisorConfig | null): Promise<void> {
		const version = ++this.version;
		this.working = true;
		this.changed.fire();
		try {
			await this.chat.saveAdvisorDefault(next);
			if (!this.isCurrent(version)) { return; }
			const saved = await this.chat.readAdvisorDefault();
			if (!this.isCurrent(version)) { return; }
			this.savedAdvisor = saved;
			this.message = localize('advisor.settings.saved', 'Advisor settings saved.');
		} catch (error) {
			if (this.isCurrent(version)) { this.message = localize('advisor.settings.saveFailed', 'Could not save Advisor settings: {0}', String(error)); }
		} finally {
			if (this.isCurrent(version)) { this.finish(); }
		}
	}

	private isCurrent(version: number): boolean { return !this.isDisposed && this.visible && version === this.version; }

	private finish(): void {
		this.working = false;
		this.changed.fire();
		if (this.reloadRequested) {
			this.reloadRequested = false;
			void this.load();
		}
	}
}

function modelChoiceValue(model: ModelCatalogEntry['model'], effort: ModelReasoningEffort | undefined): string {
	return JSON.stringify([model.provider, model.model, effort ?? null]);
}

function effortLabel(effort: ModelReasoningEffort | undefined): string {
	switch (effort) {
		case undefined: return localize('chat.modelPicker.defaultEffort', 'Default');
		case 'none': return localize('chat.modelPicker.effortNone', 'None');
		case 'minimal': return localize('chat.modelPicker.effortMinimal', 'Minimal');
		case 'low': return localize('chat.modelPicker.effortLow', 'Low');
		case 'medium': return localize('chat.modelPicker.effortMedium', 'Medium');
		case 'high': return localize('chat.modelPicker.effortHigh', 'High');
		case 'extraHigh': return localize('chat.modelPicker.effortExtraHigh', 'Extra High');
		case 'max': return localize('chat.modelPicker.effortMax', 'Max');
	}
}
