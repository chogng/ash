import './media/codeConversationDefaultsEntry.css';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { ContextView } from '../../../../base/browser/ui/contextview/contextview.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { Event } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions } from '../../../../workbench/browser/parts/dialogs/dialog.js';
import { modelPickerEffortLabel } from '../../../../workbench/contrib/chat/browser/widget/input/modelPicker/modelPickerModelConfig.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { MEMORY_SETTINGS_CATEGORY } from '../../../../workbench/contrib/memories/browser/memorySettings.js';
import { SettingsPageRenderer } from '../../../../workbench/contrib/preferences/browser/settingsRenderers.js';
import { SettingsSectionRenderer } from '../../../../workbench/contrib/preferences/browser/settingsSectionRenderer.js';
import type { SettingsSectionReference, SettingsTreeNode } from '../../../../workbench/contrib/preferences/browser/settingsTreeModels.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../../workbench/services/chat/common/modelCatalog.js';
import { codeConversationDefaultsSetting, type CodeConversationDefaults } from '../../../common/codeConversationDefaults.js';
import { CodeConversationDefaultsSettings, codeConversationDefaultsTitle } from './codeConversationDefaultsSettings.js';

export class CodeConversationDefaultsEntry extends SettingsPageRenderer<SettingsSectionReference> {
	public readonly categoryId = MEMORY_SETTINGS_CATEGORY;
	public readonly onDidChange = Event.None;
	public override get settingIds(): readonly string[] { return [codeConversationDefaultsSetting]; }

	private readonly row: HTMLElement;
	private readonly title: HTMLElement;
	private readonly summary: HTMLElement;
	private readonly manage: Button;
	private readonly activeDialog = this._register(new MutableDisposable<DisposableStore>());
	private models: readonly ModelCatalogEntry[] = [];
	private visible = false;
	private catalogRevision = 0;

	constructor(
		private readonly container: HTMLElement,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		const document = container.ownerDocument;
		this.title = h(document, 'div', { className: 'ash-configuration-setting-title' });
		this.summary = h(document, 'p', { className: 'ash-configuration-setting-description' });
		this.row = h(document, 'div', { className: 'ash-settings-field-row' },
			h(document, 'div', { className: 'ash-settings-field-copy ash-configuration-setting-copy' }, this.title, this.summary));
		this.row.dataset.settingsItemId = codeConversationDefaultsSetting;
		this.manage = this._register(new Button(this.row, {
			...defaultButtonStyles, presentation: 'secondary', size: 'small',
			label: localize('sessions.code.defaults.manage', 'Manage'),
			onClick: () => { void this.open(); },
		}));
		this.manage.domNode.setAttribute('aria-haspopup', 'dialog');
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(codeConversationDefaultsSetting)) this.updateSummary();
		}));
		this._register(languageModels.onDidChangeModels(() => { if (this.visible) void this.refreshCatalog(); }));
	}

	protected override buildNodes(): readonly SettingsTreeNode<SettingsSectionReference>[] {
		const title = codeConversationDefaultsTitle();
		this.title.textContent = title;
		this.manage.label = localize('sessions.code.defaults.manage', 'Manage');
		this.manage.domNode.setAttribute('aria-label', localize('sessions.code.defaults.manageLabel', 'Manage Code conversation defaults'));
		this.updateSummary();
		return [{
			element: {
				kind: 'item', id: codeConversationDefaultsSetting, title,
				description: localize('sessions.code.defaults.description', 'Choose the model and effort for new Code conversations.'),
				keywords: [codeConversationDefaultsSetting, localize('sessions.code.defaults.workspaceModel', 'Workspace model')],
				value: this.retainElement(codeConversationDefaultsSetting, this.row),
			},
		}];
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		if (visible) void this.refreshCatalog();
	}

	private updateSummary(): void {
		const profile = this.configuration.getValue<CodeConversationDefaults>(codeConversationDefaultsSetting)?.profile;
		if (!profile?.model) {
			this.summary.textContent = localize('sessions.code.defaults.inheritLast', 'Inherit last selection');
			return;
		}
		const identity = modelRefIdentity(profile.model);
		const name = this.models.find(entry => modelRefIdentity(entry.model) === identity)?.displayName ?? profile.model.model;
		const effort = profile.effort ? modelPickerEffortLabel(profile.effort) : localize('sessions.code.defaults.inheritEffort', 'Use default effort');
		this.summary.textContent = localize('sessions.code.defaults.summary', '{0} · {1}', name, effort);
	}

	private async refreshCatalog(): Promise<void> {
		const revision = ++this.catalogRevision;
		const models = await this.languageModels.listModelCatalog().catch(() => undefined);
		if (this.isDisposed || revision !== this.catalogRevision || !models) return;
		this.models = models;
		this.updateSummary();
	}

	private async open(): Promise<void> {
		if (this.activeDialog.value) return;
		const resources = new DisposableStore();
		this.activeDialog.value = resources;
		try {
			const document = this.container.ownerDocument;
			const content = h(document, 'div');
			const contextView = resources.add(new ContextView(content));
			const contextViewService: IContextViewService = {
				container: content,
				show: options => contextView.show(options),
				hide: reason => contextView.hide(reason),
				layout: () => contextView.layout(),
			};
			const services = resources.add(this.instantiation.createChild(new ServiceCollection([IContextViewService, contextViewService])));
			const settings = resources.add(services.createInstance(CodeConversationDefaultsSettings));
			const section = resources.add(services.createInstance(SettingsSectionRenderer, content, settings,
				AccessibleViewProviderId.ChatModelConfiguration, AccessibilityVerbositySettingId.ChatModelConfiguration));
			content.prepend(section.renderSection());
			const actions = h(document, 'div', { className: 'ash-sessions-form-actions' });
			// Settings is itself modal. A nested modal keeps keyboard focus and dropdowns in the active top layer.
			const dialog = resources.add(new Dialog(this.container, settings.title, [], createWorkbenchDialogOptions({
				layout: 'form',
				extraClasses: ['ash-code-conversation-defaults-dialog'],
				closeOnBackdropClick: true,
				disableDefaultAction: true,
				canClose: () => !settings.isSaving,
				shouldConfirmDiscard: () => settings.hasChanges,
				renderBody: body => body.append(content),
				renderFooter: footer => footer.append(actions),
			})));
			const cancel = resources.add(new Button(actions, {
				...defaultButtonStyles, presentation: 'secondary', label: localize('sessions.code.defaults.cancel', 'Cancel'),
				onClick: () => { void dialog.requestClose(); },
			}));
			const save = resources.add(new Button(actions, {
				...defaultButtonStyles, presentation: 'primary', label: localize('sessions.code.defaults.save', 'Save'), enabled: false,
				onClick: async () => {
					if (await settings.save() && !resources.isDisposed) await dialog.requestClose();
				},
			}));
			resources.add(settings.onDidChange(() => {
				cancel.enabled = !settings.isSaving;
				save.enabled = settings.hasChanges && !settings.isSaving;
			}));
			const result = dialog.show();
			section.setVisible(true);
			await result;
		} finally {
			this.activeDialog.clear();
		}
	}
}
