import './media/dictationSettingsContent.css';
import { h } from '../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { DictationConfiguration } from '../../../../../platform/dictation/common/dictationConfiguration.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IChatService } from '../../../../services/chat/common/chatService.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { DefaultSettings } from '../../../../services/preferences/common/settingsModels.js';
import type { ISetting } from '../../../../services/preferences/common/preferences.js';
import type { SettingsContent, SettingsContentItem, SettingsTreeNode } from '../../../preferences/browser/settingsTreeModels.js';
import { LocalTranscriptionModelControls } from '../../../localTranscription/browser/localTranscriptionModelControls.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import {
	AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType,
	AccessibilityVerbositySettingId, IAccessibleViewService,
} from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.DictationModels,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError('Dictation model accessibility verbosity must be boolean'); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('dictation.models.verbosityTitle', 'Dictation model accessibility help'),
		description: localize('dictation.models.verbosityDescription', 'Announce how to open accessibility help when the model table receives focus.'),
	},
});

/** Shared dictation content; each settings host owns navigation, search and setting widgets. */
export class DictationSettingsContent extends Disposable implements SettingsContent {
	public readonly categoryId = 'dictation';
	public readonly settingIds = [...Object.values(DictationConfiguration), AccessibilityVerbositySettingId.DictationModels];
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly controls: LocalTranscriptionModelControls;
	private readonly cloud: HTMLElement;
	private readonly connectionStatus: HTMLElement;
	private visible = false;
	private requestVersion = 0;

	constructor(container: HTMLElement,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IChatService private readonly chat: IChatService,
		@IPreferencesService preferences: IPreferencesService,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
	) {
		super();
		const document = container.ownerDocument;
		this.controls = this._register(instantiation.createInstance(LocalTranscriptionModelControls, h(document, 'div')));
		const updateHint = (): void => {
			const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.DictationModels);
			this.controls.setAriaDescription(hint);
		};
		this.cloud = h(document, 'div');
		this.cloud.className = 'ash-dictation-cloud-connection';
		this.connectionStatus = h(document, 'p');
		this.connectionStatus.setAttribute('role', 'status');
		this.cloud.append(this.connectionStatus);
		const connections = this._register(new Button(this.cloud, { label: localize('dictation.connections.manage', 'Manage API connections'), presentation: 'secondary' }));
		this._register(connections.onDidClick(() => { void preferences.openSettings('models'); }));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.DictationModels)) { updateHint(); }
			if (event.affectsConfiguration(DictationConfiguration.backend) || event.affectsConfiguration(DictationConfiguration.cloudProvider)) {
				this.updateVisibility();
				this.changed.fire();
			}
		}));
		this._register(chat.onDidChangeModels(() => this.updateVisibility()));
		const scoped = this._register(contextKeys.createScoped(this.controls.domNode));
		scoped.createKey('dictationModelsFocused', true);
		updateHint();
		const instanceId = generateUuid();
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type,
				priority: 110,
				name: `dictation-models-${instanceId}-${type}`,
				when: ContextKeyExpr.has('dictationModelsFocused'),
				getProvider: () => {
					const focused = document.activeElement as HTMLElement;
					if (!this.visible || !this.controls.domNode.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.DictationModels, { type },
						() => type === AccessibleViewType.Help ? localize('dictation.models.help', 'Local dictation models\nUse arrow keys to move between rows and cells. Use Tab to reach model actions. Install downloads an available model; Use model selects an installed model. Cancel stops preparation. Uninstall requires confirmation and keeps the original import directory. Preparation continues after Settings closes. Import model accepts a prepared package directory.') : this.controls.getAccessibleContent(),
						() => focused.focus(), AccessibilityVerbositySettingId.DictationModels);
				},
			}));
		}
	}

	public getNodes(): readonly SettingsTreeNode<ISetting | SettingsContentItem>[] {
		const settings = new DefaultSettings();
		const settingNode = (id: string): SettingsTreeNode<ISetting> => {
			const setting = { ...settings.get(id), presentation: 'general' as const };
			return {
				element: {
					kind: 'item', id, title: setting.title, description: setting.description,
					keywords: [id, ...setting.keywords ?? []], value: setting,
				},
			};
		};
		const children: SettingsTreeNode<ISetting | SettingsContentItem>[] = [settingNode(DictationConfiguration.backend)];
		if (this.configuration.getValue(DictationConfiguration.backend) === 'cloud') {
			children.push(settingNode(DictationConfiguration.cloudProvider), {
				element: {
					kind: 'item', id: 'dictation.connection',
					title: localize('dictation.connections.title', 'Cloud connection'),
					description: localize('dictation.connections.description', 'Cloud dictation uses an API connection that supports transcription.'),
					value: { domNode: this.cloud },
				},
			});
		} else {
			children.push({
				element: {
					kind: 'item', id: DictationConfiguration.localModel,
					title: localize('dictation.model.table', 'Local dictation models'),
					description: localize('dictation.model.tableDescription', 'Install a model, select it for dictation, or uninstall it.'),
					keywords: ['model', 'install', 'import', 'uninstall'],
					value: { domNode: this.controls.domNode },
				},
			});
		}
		children.push(settingNode(AccessibilityVerbositySettingId.DictationModels));
		return [{
			element: { kind: 'group', id: 'dictation.settings', title: localize('sessions.settings.dictation', 'Dictation'), description: '' },
			children,
		}];
	}

	public setVisible(visible: boolean): void {
		this.visible = visible;
		this.updateVisibility();
	}

	private updateVisibility(): void {
		this.requestVersion++;
		const cloud = this.configuration.getValue(DictationConfiguration.backend) === 'cloud';
		this.controls.setVisible(this.visible && !cloud);
		if (this.visible && cloud) { void this.readConnection(this.requestVersion); }
	}

	private async readConnection(version: number): Promise<void> {
		try {
			const providers = await this.chat.listModelProviders();
			if (version !== this.requestVersion || this.isDisposed) { return; }
			const connection = this.configuration.getValue(DictationConfiguration.cloudProvider) === 'xai' ? 'xai' : 'openai';
			const provider = providers.find(provider => provider.connection === connection);
			this.connectionStatus.textContent = provider?.apiKeyConfigured
				? localize('dictation.connections.configured', 'API key configured. This connection is shared with chat.')
				: localize('dictation.connections.missing', 'An API key is required. Configure it in API connections. Chat subscriptions do not grant dictation access.');
		} catch {
			if (version === this.requestVersion && !this.isDisposed) { this.connectionStatus.textContent = localize('dictation.connections.failed', 'Could not read the dictation connection.'); }
		}
	}
}
