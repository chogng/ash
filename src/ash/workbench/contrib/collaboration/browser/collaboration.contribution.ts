import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { FocusedViewContext } from '../../../common/contextkeys.js';
import { ViewContainerLocation, type WorkbenchViewRegistry, ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { CHANNELS_VIEW_ID, COLLABORATION_CONTAINER_ID } from '../common/collaboration.js';
import { CollaborationViewPane } from './collaborationViewPane.js';


/** Each product entry registers the same views in its own registry. */
export function registerCollaborationViews(registry: WorkbenchViewRegistry = ViewsRegistry, open?: (accessor: ServicesAccessor) => Promise<unknown>): void {
	registry.registerStaticViewContainer({
		id: COLLABORATION_CONTAINER_ID, title: 'Collaboration', localizationKey: { bundle: 'ash', key: 'collaboration.title' },
		location: ViewContainerLocation.Sidebar, icon: Lxicon.colab, order: 5,
		mergeViewWithContainerWhenSingleView: false,
	});
	registry.registerStaticViews(COLLABORATION_CONTAINER_ID, [{
		id: CHANNELS_VIEW_ID, title: 'Channels', localizationKey: { bundle: 'ash', key: 'collaboration.channels' },
		order: 0, canToggleVisibility: false, ctorDescriptor: new SyncDescriptor(CollaborationViewPane),
	}]);
	registerAction2(class OpenCollaboration extends Action2 {
		constructor() { super({ id: 'ash.collaboration.open', title: localize2('collaboration.open', 'Open Collaboration'), f1: true }); }
		public override async run(accessor: ServicesAccessor): Promise<void> {
			// Sessions also owns activity selection and the surrounding composition.
			if (open) await open(accessor);
			else await accessor.get(IViewsService).focusView(CHANNELS_VIEW_ID);
		}
	});
}

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Collaboration, defaultValue: true, scope: ConfigurationScope.APPLICATION,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('collaboration.invalidVerbosity', 'Collaboration accessibility verbosity must be a boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('collaboration.verbosityTitle', 'Collaboration accessibility help'); },
		get description() { return localize('collaboration.verbosityDescription', 'Announce how to open accessibility help when the channel tree receives focus.'); },
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 100, name: `collaboration${type}`, when: FocusedViewContext.isEqualTo(CHANNELS_VIEW_ID),
		getProvider: accessor => {
			const view = accessor.get(IViewsService).getViewWithId(CHANNELS_VIEW_ID);
			if (!(view instanceof CollaborationViewPane)) return undefined;
			const focused = view.element.ownerDocument.activeElement;
			return new AccessibleContentProvider(AccessibleViewProviderId.Collaboration, { type },
				() => type === AccessibleViewType.Help
					? localize('collaboration.help', 'Channels\nConnect to a collaboration server to create a space or join with an invitation. Channels and membership are saved by the server. Subchannels inherit space permissions. Administrators manage members, editors change channels, and viewers read channels. Use Up and Down to navigate, Left and Right to collapse or expand, and Enter to open channel notes. Search includes parents. Escape clears search. Use New Channel, or Shift+F10 for subchannel, rename and remove actions. F2 renames the focused channel. Removing a channel removes its subchannels for everyone. Members and Permissions manages invitations and access. Disconnect forgets this profile’s saved account without deleting shared channels. Open channel notes to edit together; viewers can read. Join or start channel call joins the current call, or starts one for an editor or administrator. Viewers can listen to an existing call. Call controls appear below. Channel membership controls access to notes and calls. Press Alt+F2 for a text view. Escape closes help.')
					: view.getAccessibleContent(),
				() => { if (focused instanceof HTMLElement && focused.isConnected) focused.focus(); else view.focus(); },
				AccessibilityVerbositySettingId.Collaboration);
		},
	});
}
