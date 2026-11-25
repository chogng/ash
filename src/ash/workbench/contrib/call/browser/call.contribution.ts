import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ICallService } from '../../../../platform/call/common/callService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { CHANNELS_VIEW_ID } from '../../collab/common/collab.js';
import { CollabViewPane } from '../../collab/browser/collabViewPane.js';
import { CallsFocusedContext } from './callWidget.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Calls, defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Calls accessibility verbosity must be boolean'); } return value; },
	setting: {
		valueType: 'boolean',
		get title() { return localize('call.verbosityTitle', 'Calls accessibility help'); },
		get description() { return localize('call.verbosityDescription', 'Announce keyboard help when the call controls receive focus.'); },
	},
});

export function registerCallActions(): void {
	registerWorkbenchContribution('workbench.contrib.call', WorkbenchPhase.BlockStartup, accessor => {
		const registrations = new DisposableStore();
		if (!accessor.getOptional(ICallService)) { return registrations; }
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			registrations.add(AccessibleViewRegistry.register({
				type, priority: 100, name: `calls${type}`,
				when: CallsFocusedContext.isEqualTo(true),
				getProvider: accessor => {
					const view = accessor.get(IViewsService).getViewWithId(CHANNELS_VIEW_ID);
					const calls = view instanceof CollabViewPane ? view.callControls : undefined;
					if (!calls) return undefined;
					const focused = getActiveElement(calls.element.ownerDocument);
					if (!isHTMLElement(focused) || !calls.element.contains(focused)) return undefined;
					return new AccessibleContentProvider(AccessibleViewProviderId.Calls, { type },
						() => type === AccessibleViewType.View ? calls.getAccessibleContent() : localize({ bundle: 'ash.workbench', key: 'call.accessibilityHelp' }, 'Create a call on this computer or a server, or join with an invitation. Your microphone starts off. Use Tab and Shift+Tab to move between controls and Enter or Space to activate a button. Muting stops sending audio; Stop listening stops playback. Share screen opens a display or window selector. Use arrow keys to choose a source, then Start sharing. Escape cancels selection. Stop sharing ends screen capture without leaving the call. Shared screen images are labeled by participant; their visual contents are not transcribed. Sharing stops when its window closes, the call reconnects, or you leave. The call owner can link the active remotely collaborating document. Open document joins in a new untitled editor and asks for a separate document invitation token. Unlink document removes only the call reference; document access and editing continue independently. Leave disconnects only you. End for everyone closes the room. Invitation keys grant access: share them only with people you want in the call. Escape closes this help.'),
						() => { if (focused.isConnected) focused.focus(); }, AccessibilityVerbositySettingId.Calls);
				},
			}));
		}
		registrations.add(registerAction2(class OpenCalls extends Action2 {
			constructor() { super({ id: 'ash.call.open', title: localize2({ bundle: 'ash.workbench', key: 'command.OpenCalls' }, 'Open Calls'), f1: true }); }
			public override async run(accessor: ServicesAccessor): Promise<boolean> {
				await accessor.get(ICommandService).executeCommand('ash.collaboration.open');
				const views = accessor.get(IViewsService);
				const view = views.isViewVisible(CHANNELS_VIEW_ID) ? views.getViewWithId(CHANNELS_VIEW_ID) : undefined;
				if (!(view instanceof CollabViewPane) || !view.callControls) return false;
				view.callControls.focus();
				return true;
			}
		}));
		return registrations;
	});
}
