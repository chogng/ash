import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { modelPickerEffortLabel } from '../../../../workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerModelConfig.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../../workbench/services/chat/common/modelCatalog.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../../../workbench/services/preferences/common/preferences.js';
import { agentHostSessionWorkspaceKey } from '../../../common/agentHostSessionWorkspace.js';
import { codeConversationDefaultsSetting, codeConversationWorkspaceKey, type CodeConversationDefaults, type CodeConversationModel } from '../../../common/codeConversationDefaults.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

export class CodeConversationDefaultsSettings extends Disposable implements SettingsSectionModel {
	readonly categoryId = 'models';
	readonly itemId = 'sessions.code.conversationDefaults';
	readonly hideInnerTitle = true;
	readonly settingIds = [codeConversationDefaultsSetting];
	get title(): string { return localize('sessions.code.defaults.title', 'New Code conversations'); }
	get description(): string {
		const { key, path } = this.workspace;
		const description = localize('sessions.code.defaults.description', 'Choose the model and effort for new conversations. A workspace can use its own pair.');
		return description + ' ' + (key && path
			? localize('sessions.code.defaults.workspacePath', 'The workspace defaults below apply to new conversations in {0}.', path)
			: localize('sessions.code.defaults.workspaceMissing', 'Select a workspace in Code to set its defaults.'));
	}
	get help(): string { return localize('sessions.code.defaults.help', 'Use Tab to reach each model or effort selector. Choose Inherit last selection to reuse the last pair. Choose Use new conversation settings to remove the workspace override. Changes apply to new Code conversations.'); }
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private models: readonly ModelCatalogEntry[] = [];
	private visible = false;
	private loading = false;
	private saving = false;
	private loadRevision = 0;
	private status = '';

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
	) {
		super();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (this.visible && event.affectsConfiguration(codeConversationDefaultsSetting)) this.changed.fire();
		}));
		this._register(languageModels.onDidChangeModels(() => { if (this.visible) void this.load(); }));
		this._register(sessions.onDidChange(() => { if (this.visible) this.changed.fire(); }));
	}

	get fields(): readonly SettingsSectionField[] {
		const { key } = this.workspace;
		const defaults = this.read();
		return [
			...this.fieldsFor(defaults.profile),
			...this.fieldsFor(key ? defaults.workspaces[key] : undefined, { key }),
			{ id: 'code-conversation-defaults-status', kind: 'status', text: this.status },
		];
	}

	private get workspace(): { readonly key?: string; readonly path?: string; } {
		const draft = this.sessions.activeUntitledSession;
		if (draft) return { key: codeConversationWorkspaceKey(draft.workspace), path: 'root' in draft.workspace ? draft.workspace.root : undefined };
		const workspace = this.sessions.active?.session.workspace;
		return { key: agentHostSessionWorkspaceKey(workspace), path: workspace?.root };
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		if (visible) void this.load();
		else this.loadRevision++;
	}

	private fieldsFor(saved: CodeConversationModel | undefined, workspace?: { readonly key?: string; }): readonly SettingsSectionField[] {
		const prefix = workspace ? 'workspace' : 'profile';
		const enabled = !this.loading && !this.saving && (!workspace || !!workspace.key);
		const modelValue = saved?.model ? modelRefIdentity(saved.model) : '';
		const entries = this.models;
		const entry = entries.find(candidate => modelRefIdentity(candidate.model) === modelValue);
		const effortOptions = entry?.supportedReasoningEfforts ?? [];
		const modelOptions = [
			{ value: '', label: workspace ? localize('sessions.code.defaults.inheritProfile', 'Use new conversation settings') : localize('sessions.code.defaults.inheritLast', 'Inherit last selection') },
			...entries.map(model => ({ value: modelRefIdentity(model.model), label: model.displayName })),
		];
		if (saved?.model && !entry) modelOptions.push({ value: modelValue, label: localize('sessions.code.defaults.unavailable', '{0} (unavailable)', saved.model.model) });
		return [
			{
				id: `${prefix}-model`, kind: 'select', value: modelValue, options: modelOptions, enabled,
				label: workspace ? localize('sessions.code.defaults.workspaceModel', 'Workspace model') : localize('sessions.code.defaults.model', 'New conversation model'),
				setValue: value => {
					if (!enabled) return;
					if (!value) { void this.save(workspace?.key, undefined); return; }
					const next = entries.find(model => modelRefIdentity(model.model) === value);
					if (!next) return;
					const efforts = next.supportedReasoningEfforts ?? [];
					const effort = efforts.find(option => option.effort === saved?.effort)?.effort
						?? efforts.find(option => option.effort === next.defaultReasoningEffort)?.effort ?? efforts[0]?.effort;
					void this.save(workspace?.key, { model: next.model, effort });
				},
			},
			{
				id: `${prefix}-effort`, kind: 'select', value: effortOptions.find(option => option.effort === saved?.effort)?.effort, enabled: enabled && effortOptions.length > 0,
				label: workspace ? localize('sessions.code.defaults.workspaceEffort', 'Workspace effort') : localize('sessions.code.defaults.effort', 'New conversation effort'),
				options: effortOptions.map(option => ({ value: option.effort, label: modelPickerEffortLabel(option.effort) })),
				setValue: value => {
					const effort = effortOptions.find(option => option.effort === value)?.effort;
					if (enabled && entry && effort) void this.save(workspace?.key, { model: entry.model, effort });
				},
			},
		];
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
			if (this.visible && revision === this.loadRevision) this.models = models;
		} catch {
			if (this.visible && revision === this.loadRevision) {
				this.models = [];
				this.status = localize('sessions.code.defaults.loadFailed', 'Could not load models.');
			}
		} finally {
			if (this.visible && revision === this.loadRevision) { this.loading = false; this.changed.fire(); }
		}
	}

	private async save(workspace: string | undefined, selection: CodeConversationModel | undefined): Promise<void> {
		if (!this.visible || this.isDisposed || this.saving) return;
		this.saving = true;
		this.status = '';
		this.changed.fire();
		try {
			const current = this.read();
			const workspaces = { ...current.workspaces };
			if (workspace) {
				if (selection) workspaces[workspace] = selection;
				else delete workspaces[workspace];
			}
			const profile = workspace ? current.profile : selection;
			await this.configuration.updateValue(codeConversationDefaultsSetting, { ...(profile ? { profile } : {}), workspaces }, ConfigurationTarget.USER_LOCAL);
		} catch {
			this.status = localize('sessions.code.defaults.saveFailed', 'Could not save conversation defaults.');
		} finally {
			this.saving = false;
			if (!this.isDisposed) this.changed.fire();
		}
	}
}
