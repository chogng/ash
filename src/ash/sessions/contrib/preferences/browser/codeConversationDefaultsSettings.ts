import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { modelPickerEffortLabel } from '../../../../workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerModelConfig.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { MEMORY_SETTINGS_CATEGORY } from '../../../../workbench/contrib/memories/browser/memorySettings.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../../workbench/services/chat/common/modelCatalog.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../../../workbench/services/preferences/common/preferences.js';
import { agentHostSessionWorkspaceKey } from '../../../common/agentHostSessionWorkspace.js';
import { codeConversationDefaultsSetting, codeConversationWorkspaceKey, type CodeConversationDefaults, type CodeConversationModel } from '../../../common/codeConversationDefaults.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

export const codeConversationDefaultsTitle = () => localize('sessions.code.defaults.title', 'Code conversation defaults');

function sameSelection(left: CodeConversationModel | undefined, right: CodeConversationModel | undefined): boolean {
	return left?.effort === right?.effort
		&& left?.model?.provider === right?.model?.provider
		&& left?.model?.model === right?.model?.model;
}

export class CodeConversationDefaultsSettings extends Disposable implements SettingsSectionModel {
	readonly categoryId = MEMORY_SETTINGS_CATEGORY;
	readonly hideInnerTitle = true;
	get title(): string { return codeConversationDefaultsTitle(); }
	get description(): string {
		const { key, path } = this.workspace;
		return key && path
			? localize('sessions.code.defaults.workspacePath', 'Workspace defaults apply to new Code conversations in {0}.', path)
			: localize('sessions.code.defaults.workspaceMissing', 'Select a workspace in Code to set its defaults.');
	}
	get help(): string { return localize('sessions.code.defaults.help', 'Use Tab to reach each model or effort selector. Choose Inherit last selection to reuse your last choices. Choose Use personal defaults to clear the workspace override. Select Save to apply the changes to new Code conversations, or Cancel to close without saving.'); }
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly workspace: { readonly key?: string; readonly path?: string; };
	private originalProfile: CodeConversationModel | undefined;
	private originalWorkspace: CodeConversationModel | undefined;
	private profileSelection: CodeConversationModel | undefined;
	private workspaceSelection: CodeConversationModel | undefined;
	private models: readonly ModelCatalogEntry[] = [];
	private visible = false;
	private loading = false;
	private saving = false;
	private loadRevision = 0;
	private loadFailed = false;
	private saveFailed = false;

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
		@ISessionsManagementService sessions: ISessionsManagementService,
	) {
		super();
		// Keep the target shown in the form stable until the dialog closes.
		const draft = sessions.activeUntitledSession;
		const workspace = sessions.active?.session.workspace;
		this.workspace = draft
			? { key: codeConversationWorkspaceKey(draft.workspace), path: 'root' in draft.workspace ? draft.workspace.root : undefined }
			: { key: agentHostSessionWorkspaceKey(workspace), path: workspace?.root };
		const defaults = this.read();
		this.profileSelection = this.originalProfile = defaults.profile;
		this.workspaceSelection = this.originalWorkspace = this.workspace.key ? defaults.workspaces[this.workspace.key] : undefined;
		this._register(languageModels.onDidChangeModels(() => { if (this.visible) void this.load(); }));
	}

	get fields(): readonly SettingsSectionField[] {
		return [
			...this.fieldsFor(this.profileSelection, false),
			...(this.workspace.key ? this.fieldsFor(this.workspaceSelection, true) : []),
			{ id: 'code-conversation-defaults-status', kind: 'status', text: this.status },
		];
	}

	get hasChanges(): boolean {
		return !sameSelection(this.profileSelection, this.originalProfile) || !sameSelection(this.workspaceSelection, this.originalWorkspace);
	}

	get isSaving(): boolean { return this.saving; }

	private get status(): string {
		if (this.saveFailed) return localize('sessions.code.defaults.saveFailed', 'Could not save conversation defaults.');
		if (this.loading) return localize('sessions.code.defaults.loading', 'Loading models…');
		if (this.loadFailed) return localize('sessions.code.defaults.loadFailed', 'Could not load models.');
		return '';
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		if (visible) void this.load();
		else this.loadRevision++;
	}

	private fieldsFor(saved: CodeConversationModel | undefined, workspace: boolean): readonly SettingsSectionField[] {
		const prefix = workspace ? 'workspace' : 'profile';
		const enabled = this.visible && !this.loading && !this.saving;
		const modelValue = saved?.model ? modelRefIdentity(saved.model) : '';
		const entries = this.models;
		const entry = entries.find(candidate => modelRefIdentity(candidate.model) === modelValue);
		const effortOptions = entry?.supportedReasoningEfforts ?? [];
		const modelOptions = [
			{ value: '', label: workspace ? localize('sessions.code.defaults.inheritProfile', 'Use personal defaults') : localize('sessions.code.defaults.inheritLast', 'Inherit last selection') },
			...entries.map(model => ({ value: modelRefIdentity(model.model), label: model.displayName })),
		];
		if (saved?.model && !entry) modelOptions.push({ value: modelValue, label: localize('sessions.code.defaults.unavailable', '{0} (unavailable)', saved.model.model) });
		return [
			{
				id: `${prefix}-model`, kind: 'select', value: modelValue, options: modelOptions, enabled,
				label: workspace ? localize('sessions.code.defaults.workspaceModel', 'Workspace model') : localize('sessions.code.defaults.model', 'Personal default model'),
				setValue: value => {
					if (!enabled) return;
					if (!value) { this.setSelection(workspace, undefined); return; }
					const next = entries.find(model => modelRefIdentity(model.model) === value);
					if (!next) return;
					const effort = next.supportedReasoningEfforts?.find(option => option.effort === saved?.effort)?.effort;
					this.setSelection(workspace, { model: next.model, effort });
				},
			},
			{
				id: `${prefix}-effort`, kind: 'select', value: effortOptions.find(option => option.effort === saved?.effort)?.effort ?? '', enabled: enabled && effortOptions.length > 0,
				label: workspace ? localize('sessions.code.defaults.workspaceEffort', 'Workspace effort') : localize('sessions.code.defaults.effort', 'Personal default effort'),
				options: [
					{ value: '', label: localize('sessions.code.defaults.inheritEffort', 'Use default effort') },
					...effortOptions.map(option => ({ value: option.effort, label: modelPickerEffortLabel(option.effort) })),
				],
				setValue: value => {
					if (!enabled || !entry) return;
					const effort = effortOptions.find(option => option.effort === value)?.effort;
					if (value === '' || effort) this.setSelection(workspace, { model: entry.model, effort });
				},
			},
		];
	}

	private setSelection(workspace: boolean, selection: CodeConversationModel | undefined): void {
		if (workspace) this.workspaceSelection = selection;
		else this.profileSelection = selection;
		this.saveFailed = false;
		this.changed.fire();
	}

	private read(): CodeConversationDefaults {
		return this.configuration.getValue<CodeConversationDefaults>(codeConversationDefaultsSetting) ?? { workspaces: {} };
	}

	private async load(): Promise<void> {
		const revision = ++this.loadRevision;
		this.loading = true;
		this.changed.fire();
		try {
			const models = await this.languageModels.listModels();
			if (this.visible && revision === this.loadRevision) {
				this.models = models;
				this.loadFailed = false;
			}
		} catch {
			if (this.visible && revision === this.loadRevision) this.loadFailed = true;
		} finally {
			if (this.visible && revision === this.loadRevision) { this.loading = false; this.changed.fire(); }
		}
	}

	async save(): Promise<boolean> {
		if (!this.visible || this.isDisposed || this.saving || !this.hasChanges) return false;
		this.saving = true;
		this.saveFailed = false;
		this.changed.fire();
		try {
			const current = this.read();
			const workspaces = { ...current.workspaces };
			const key = this.workspace.key;
			if (key && !sameSelection(this.workspaceSelection, this.originalWorkspace)) {
				if (this.workspaceSelection) workspaces[key] = this.workspaceSelection;
				else delete workspaces[key];
			}
			// Retain settings that another window changed while this form was open.
			const profile = sameSelection(this.profileSelection, this.originalProfile) ? current.profile : this.profileSelection;
			await this.configuration.updateValue(codeConversationDefaultsSetting, { ...(profile ? { profile } : {}), workspaces }, ConfigurationTarget.USER_LOCAL);
			this.originalProfile = this.profileSelection;
			this.originalWorkspace = this.workspaceSelection;
			return true;
		} catch {
			this.saveFailed = true;
			return false;
		} finally {
			this.saving = false;
			if (!this.isDisposed) this.changed.fire();
		}
	}
}
