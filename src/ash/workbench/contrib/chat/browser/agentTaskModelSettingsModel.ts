import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAgentModelsService, type AgentModelDefaults, type AgentModelDefaultsUpdate } from '../../../../platform/models/common/agentModels.js';
import { ILanguageModelsService } from '../common/languageModels.js';
import { ModelPurpose, modelsRecommendedFor, modelRefIdentity, type ModelCatalogEntry, type ModelReasoningEffort } from '../../../services/chat/common/modelCatalog.js';
import type { SettingsMenuOption, SettingsSectionField, SettingsSectionModel } from '../../../services/preferences/common/preferences.js';
import { taskModelMenuRows } from './taskModelMenu.js';

/** Edits a backend task default without changing the conversation model. */
export class AgentTaskModelSettingsModel extends Disposable implements SettingsSectionModel {
	public readonly categoryId = 'agents';
	public readonly groupId = null;
	public get itemId(): string {
		switch (this.kind) {
			case 'codeReviewModel': return 'chat.codeReview';
			case 'commitMessageModel': return 'chat.commitMessage';
			case 'threadTitleModel': return 'chat.threadTitle';
			case 'threadRecapModel': return 'chat.threadRecap';
		}
	}
	public get keywords(): readonly string[] {
		if (this.kind === 'threadRecapModel') { return ['recap', 'summary', 'conversation', 'model', this.title]; }
		if (this.kind === 'threadTitleModel') { return ['title', 'conversation', 'model', this.title]; }
		return this.kind === 'codeReviewModel'
			? ['review', 'model', 'code review', 'find issues', localize('codeReview.settings.keyword', 'Code review'), localize('scm.review.findIssues', 'Find Issues')]
			: ['commit', 'model', 'commit message', 'git'];
	}
	public get title(): string {
		if (this.kind === 'threadRecapModel') { return localize('threadRecap.settings.title', 'Conversation recap'); }
		if (this.kind === 'threadTitleModel') { return localize('threadTitle.settings.title', 'Conversation titles'); }
		if (this.kind === 'commitMessageModel') {
			return localize('commitMessage.settings.title', 'Commit');
		}
		return localize('codeReview.settings.title', 'Code review');
	}
	public get description(): string {
		if (this.kind === 'threadRecapModel') {
			return localize('threadRecap.settings.description', 'Choose the model for /recap and automatic conversation recaps. Automatic model selection uses a recommended low-cost model from the conversation provider when available.');
		}
		if (this.kind === 'threadTitleModel') {
			return localize('threadTitle.settings.description', 'Generate a short title from the first message. Automatic uses a recommended low-cost model from the conversation provider when available.');
		}
		if (this.kind === 'commitMessageModel') {
			return localize('commitMessage.settings.description', 'Changing the model requires authorizing directories again.');
		}
		return localize('codeReview.settings.description', 'Choose the model that reviews code changes and reports issues.');
	}
	public get help(): string {
		if (this.kind === 'threadRecapModel') {
			return localize('threadRecap.settings.help', 'Conversation recap settings\nUse Tab to reach Generate recaps automatically and Space to toggle it. Automatic recaps require at least three completed turns and 30 minutes with the conversation idle and unfocused. Use Tab to reach Model, Enter or Space to open it, and Up or Down Arrow to browse. Press Right Arrow on a model to see its reasoning levels, then Enter to save. Use /recap in an idle conversation to request a recap at any time. Escape closes this help and returns focus.');
		}
		if (this.kind === 'threadTitleModel') {
			return localize('threadTitle.settings.help', 'Conversation title settings\nUse Tab to reach Model. Press Enter or Space to open the menu and Up or Down Arrow to browse. Press Right Arrow on a model to see its reasoning levels, then Enter to save. Automatic uses a recommended low-cost model from the conversation provider when available. Escape closes this help and returns focus.');
		}
		if (this.kind === 'commitMessageModel') {
			return localize('commitMessage.settings.help', 'Commit message settings\nUse Tab to reach Automatically generate commit messages and Space to toggle it. Turning it off keeps the selected model. Use Tab to reach Model. Press Enter or Space to open it, use the arrow keys to select a model, and press Enter to save immediately. Inherit conversation model uses the model from the conversation turn that produced the changes, even if you later change the conversation model. If that model is unavailable, choose a dedicated model. Changing the selection clears directory authorizations; authorize the resolved model before its source changes can be sent. Models and connections are managed in Models. Escape closes this help and returns focus.');
		}
		return localize('codeReview.settings.help', 'Review model settings\nUse Tab to reach the model selector. Press Enter or Space to open it and Up or Down Arrow to browse. Press Right Arrow on a model to see its reasoning levels, then Enter to save. Follow Current Model clears the code-review override. The selection applies to future code reviews, including current, staged, branch and custom reviews from Find Issues. Models and connections are managed in Models. An unavailable saved model remains visible; choose an available model before reviewing. Escape closes this help and returns focus.');
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
		private readonly kind: 'codeReviewModel' | 'commitMessageModel' | 'threadTitleModel' | 'threadRecapModel',
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
		const [purpose, fieldId, defaultLabel] = this.kind === 'threadRecapModel'
			? [ModelPurpose.ThreadRecap, 'thread-recap-model', localize('threadTitle.settings.automatic', 'Automatic')]
			: this.kind === 'threadTitleModel'
				? [ModelPurpose.ThreadTitle, 'thread-title-model', localize('threadTitle.settings.automatic', 'Automatic')]
				: this.kind === 'commitMessageModel'
					? [ModelPurpose.Commit, 'commit-message-model', localize('commitMessage.settings.inherit', 'Inherit conversation model')]
					: [ModelPurpose.Review, 'code-review-model', localize('codeReview.settings.follow', 'Follow Current Model')];
		const recommended = modelsRecommendedFor(this.models, purpose);
		const candidates = this.kind === 'threadRecapModel'
			? [...recommended, ...this.models.filter(entry => !entry.recommendedFor?.includes(purpose)
				&& (entry.inputModalities == null || entry.inputModalities.includes('text'))
				&& entry.discovered !== false && !entry.retirement)]
			: recommended;
		const entries = candidates.filter(entry => this.languageModels.isModelVisible(entry.model));
		const selectedId = selected ? modelRefIdentity(selected) : '';
		if (selected && !entries.some(entry => modelRefIdentity(entry.model) === selectedId)) {
			entries.push(this.models.find(entry => modelRefIdentity(entry.model) === selectedId) ?? {
				model: selected, longContext: null,
				displayName: localize('codeReview.settings.unavailable', '{0} (unavailable)', `${selected.provider}/${selected.model}`),
			});
		}
		const common = {
			id: fieldId,
			label: localize('codeReview.settings.selector', 'Model'),
			description: this.description,
			enabled: !!this.snapshot && !this.busy,
		};
		const automatic = { value: '', label: defaultLabel };
		const selector: SettingsSectionField = this.kind === 'commitMessageModel' ? {
			...common, kind: 'select', value: selectedId,
			options: [automatic, ...entries.map(entry => ({ value: modelRefIdentity(entry.model), label: entry.displayName }))],
			setValue: value => {
				const model = this.models.find(entry => modelRefIdentity(entry.model) === value)?.model;
				if (value && !model) return;
				void this.save({ commitMessageModel: model ?? null });
			},
		} : this.modelMenu(common, automatic, entries);
		const fields: SettingsSectionField[] = [
			selector,
			{ id: fieldId.replace(/-model$/, '-status'), kind: 'status', text: this.message },
		];
		if (this.kind === 'threadRecapModel') {
			fields.unshift({
				id: 'thread-recap-enabled', kind: 'boolean',
				label: localize('threadRecap.settings.enabled', 'Generate recaps automatically'),
				value: this.snapshot?.threadRecapEnabled ?? false, enabled: !!this.snapshot && !this.busy,
				setValue: enabled => { void this.save({ threadRecapEnabled: enabled }); },
			});
		}
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

	private modelMenu(common: { id: string; label: string; description: string; enabled: boolean; }, automatic: { value: string; label: string; }, entries: readonly ModelCatalogEntry[]): SettingsSectionField {
		const kind = this.kind;
		const saved = this.snapshot?.[kind];
		const savedId = saved && modelRefIdentity(saved);
		const rows = taskModelMenuRows(entries, saved, kind === 'codeReviewModel'
			? entry => entry.effectiveReasoningEffort ?? entry.defaultReasoningEffort
			: shortTextDefaultEffort);
		const summary = rows.find(row => row.id === savedId)?.summary;
		const options: SettingsMenuOption[] = [automatic];
		if (rows.length) options.push({ separator: true }, ...rows.map(row => row.option));
		return {
			...common, kind: 'menu', options, value: summary?.value ?? automatic.value,
			valueLabel: summary?.label ?? automatic.label, valueDescription: summary?.labelDescription,
			setValue: value => {
				if (value === automatic.value) {
					void this.save({ [kind]: null });
					return;
				}
				for (const row of rows) {
					const choice = row.choices.find(choice => choice.value === value);
					if (choice && this.models.some(entry => modelRefIdentity(entry.model) === row.id)) {
						void this.save({ [kind]: { ...row.model, ...(choice.effort === undefined ? {} : { reasoningEffort: choice.effort }) } });
						return;
					}
				}
			},
		};
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
			: this.kind === 'threadTitleModel'
				? localize('threadTitle.settings.loading', 'Loading title model...')
				: this.kind === 'threadRecapModel'
					? localize('threadRecap.settings.loading', 'Loading recap model...')
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
					: this.kind === 'threadTitleModel'
						? localize('threadTitle.settings.loadFailed', 'Could not load title model: {0}', String(error))
						: this.kind === 'threadRecapModel'
							? localize('threadRecap.settings.loadFailed', 'Could not load recap model: {0}', String(error))
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
				: this.kind === 'threadTitleModel'
					? localize('threadTitle.settings.saved', 'Title model saved.')
					: this.kind === 'threadRecapModel'
						? localize('threadRecap.settings.saved', 'Recap model saved.')
						: localize('codeReview.settings.saved', 'Review model saved.');
		} catch (error) {
			if (this.isCurrent(revision)) {
				this.message = this.kind === 'commitMessageModel'
					? localize('commitMessage.settings.saveFailed', 'Could not save commit message settings: {0}', String(error))
					: this.kind === 'threadTitleModel'
						? localize('threadTitle.settings.saveFailed', 'Could not save title model: {0}', String(error))
						: this.kind === 'threadRecapModel'
							? localize('threadRecap.settings.saveFailed', 'Could not save recap model: {0}', String(error))
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

/** The App Server uses these low-cost levels for titles and recaps without an explicit effort. */
function shortTextDefaultEffort(entry: ModelCatalogEntry): ModelReasoningEffort | undefined {
	const order: readonly ModelReasoningEffort[] = ['none', 'minimal', 'low'];
	return order.find(effort => entry.supportedReasoningEfforts?.some(option => option.effort === effort)) ?? entry.defaultReasoningEffort;
}
