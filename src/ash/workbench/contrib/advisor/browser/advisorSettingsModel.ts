import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILanguageModelsService } from '../../chat/common/languageModels.js';
import { taskModelMenuRows } from '../../preferences/browser/taskModelMenu.js';
import { updateAdvisorConfig } from '../../../services/chat/common/advisor.js';
import { IChatService, type AdvisorConfig } from '../../../services/chat/common/chatService.js';
import { ModelPurpose, modelsRecommendedFor, modelRefIdentity, type ModelCatalogEntry } from '../../../services/chat/common/modelCatalog.js';
import type { SettingsMenuOption, SettingsSectionField, SettingsSectionModel } from '../../../services/preferences/common/preferences.js';

/** Advisor settings data; each host supplies the shared Preferences renderer. */
export class AdvisorSettingsModel extends Disposable implements SettingsSectionModel {
	readonly categoryId = 'agents';
	readonly groupId = null;
	readonly itemId = 'chat.advisor';
	get title(): string { return localize('advisor.settings.title', 'Advisor'); }
	get description(): string { return localize('advisor.settings.description', 'Choose a higher-intelligence model to provide strategic guidance while the executor continues with the task.'); }
	get keywords(): readonly string[] { return ['advisor', 'model', 'second opinion', localize('advisor.settings.model', 'Advisor model')]; }
	get help(): string { return localize('advisor.settings.help', 'Advisor settings\nUse Tab to reach Advisor model. Press Enter or Space to open the menu and use Up or Down Arrow to browse. Inherit from chat uses the current chat model and reasoning effort. Disable turns Advisor off and keeps the saved selection. Below the divider, press Right Arrow or Enter on a model to open its reasoning effort choices, when available. Press Enter to save a choice. Left Arrow returns to the model list, and Escape closes the current menu or help.'); }
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
		const models = this.modelChoices();
		const inherit = { value: 'inherit', label: localize('advisor.settings.inherit', 'Inherit from chat') };
		const disabled = { value: '', label: localize('advisor.settings.disabled', 'Disable') };
		const options: SettingsMenuOption[] = [inherit, disabled];
		if (models.length) options.push({ separator: true });
		let selected: { value: string; label: string; labelDescription?: string; } = advisor?.enabled ? inherit : disabled;
		const savedModel = advisor?.model;
		for (const { id, summary, option } of models) {
			options.push(option);
			if (advisor?.enabled && savedModel && id === modelRefIdentity(savedModel)) {
				selected = summary;
			}
		}
		return [{
			id: 'advisor-model', kind: 'menu', label: localize('advisor.settings.model', 'Advisor model'),
			description: this.description, value: selected.value, valueLabel: selected.label, valueDescription: selected.labelDescription,
			options, enabled: this.loaded && !this.working,
			setValue: value => this.selectModel(value),
		}, { id: 'advisor-status', kind: 'status', text: this.message }];
	}

	private modelChoices() {
		const entries = [...modelsRecommendedFor(this.models, ModelPurpose.Advisor).filter(entry => this.languageModels.isModelVisible(entry.model))];
		const saved = this.savedAdvisor;
		const savedModel = saved?.model;
		// Recommendation and visibility updates never replace a saved selection.
		if (savedModel && !entries.some(entry => modelRefIdentity(entry.model) === modelRefIdentity(savedModel))) {
			entries.push(this.models.find(entry => modelRefIdentity(entry.model) === modelRefIdentity(savedModel)) ?? {
				model: savedModel, displayName: `${savedModel.provider}/${savedModel.model}`, longContext: null,
			});
		}
		return taskModelMenuRows(entries, savedModel && { ...savedModel, reasoningEffort: saved?.reasoningEffort });
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
		for (const { model, choices } of this.modelChoices()) {
			const selected = choices.find(choice => choice.value === value);
			if (selected) {
				void this.save(updateAdvisorConfig(this.savedAdvisor, { type: 'selectModel', model: { model }, reasoningEffort: selected.effort ?? null }));
				return;
			}
		}
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
