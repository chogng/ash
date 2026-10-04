import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { FocusedViewContext } from '../../../common/contextkeys.js';
import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ICallService } from '../../../../platform/call/common/callService.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewContainerLocation, ViewsRegistry } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { CallViewPane } from './callViewPane.js';
import './media/call.css';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.calls', defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Calls accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: 'Calls accessibility help', description: 'Announce keyboard help when the Calls view receives focus.' },
});

registerWorkbenchContribution('workbench.contrib.call', WorkbenchPhase.BlockStartup, accessor => {
	const registrations = new DisposableStore();
	if (!accessor.getOptional(ICallService)) { return registrations; }
	registrations.add(ViewsRegistry.registerViewContainer({ id: 'ash.call', title: 'Calls', location: ViewContainerLocation.Panel, order: 4 }));
	registrations.add(ViewsRegistry.registerViews('ash.call', [{
		id: 'ash.call.view', title: 'Calls', canToggleVisibility: false,
		ctorDescriptor: new SyncDescriptor(CallViewPane),
	}]));
	registrations.add(AccessibleViewRegistry.register({
		type: AccessibleViewType.Help, priority: 100, name: 'callsHelp',
		when: FocusedViewContext.isEqualTo('ash.call.view'),
		getProvider: accessor => {
			const view = accessor.get(IViewsService).getViewWithId('ash.call.view');
			if (!(view instanceof CallViewPane)) { return undefined; }
			const focused = view.element.ownerDocument.activeElement;
			return new AccessibleContentProvider(AccessibleViewProviderId.Calls, { type: AccessibleViewType.Help },
				() => localize({ bundle: 'ash.workbench', key: 'call.accessibilityHelp' }, "Create a call on this computer or a server, or join with an invitation. Your microphone starts off. Use Tab and Shift+Tab to move between controls and Enter or Space to activate a button. Muting stops sending audio; Stop listening stops playback. Share screen opens a display or window selector. Use arrow keys to choose a source, then Start sharing. Escape cancels selection. Stop sharing ends screen capture without leaving the call. Shared screen images are labeled by participant; their visual contents are not transcribed. Sharing stops when its window closes, the call reconnects, or you leave. Leave disconnects only you. End for everyone closes the room. Invitation keys grant access: share them only with people you want in the call. Escape closes this help."),
				() => { if (focused instanceof HTMLElement && focused.isConnected) { focused.focus(); } }, AccessibilityVerbositySettingId.Calls);
		},
	}));
	registrations.add(registerAction2(class OpenCalls extends Action2 {
		constructor() { super({ id: 'ash.call.open', title: localize2({ bundle: 'ash.workbench', key: 'command.OpenCalls' }, 'Open Calls'), f1: true }); }
		public override run(accessor: ServicesAccessor): Promise<boolean> { return accessor.get(IViewsService).focusView('ash.call.view'); }
	}));
	return registrations;
});
