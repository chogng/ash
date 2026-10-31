import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AgentRolesWidget } from './agentRolesWidget.js';
import { SettingsPageRenderer } from './settingsRenderers.js';
import type { SettingsSectionReference, SettingsTreeNode } from './settingsTreeModels.js';

/** Adapts the shared role controls to Preferences search and section lifetimes. */
export class AgentRolesSettingsRenderer extends SettingsPageRenderer<SettingsSectionReference> {
	public readonly categoryId = 'agents';
	private readonly roles: AgentRolesWidget;
	public get onDidChange(): AgentRolesWidget['onDidChange'] { return this.roles.onDidChange; }

	constructor(container: HTMLElement, @IInstantiationService instantiation: IInstantiationService) {
		super();
		this.roles = this._register(instantiation.createInstance(AgentRolesWidget, container, {}));
		// The Settings tree mounts retained controls only for the selected category or search.
		this.roles.domNode.remove();
	}

	protected override buildNodes(): readonly SettingsTreeNode<SettingsSectionReference>[] {
		return [{
			element: {
				kind: 'item', id: 'agents.definitions',
				title: localize({ bundle: 'ash.settings', key: 'roles.title' }, 'Agent definitions'),
				description: '', keywords: this.roles.keywords,
				value: this.retainElement('agents.definitions', this.roles.domNode),
			}
		}];
	}

	public setVisible(visible: boolean): void {
		this.roles.setVisible(visible);
	}
}
