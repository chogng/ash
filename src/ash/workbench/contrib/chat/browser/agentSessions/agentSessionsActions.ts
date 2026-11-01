import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { Dimension } from '../../../../../base/browser/dom.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../../common/views.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { IWorkbenchLayoutService, isHorizontal } from '../../../../services/layout/browser/layoutService.js';
import { AgentSessionsPresentation, AgentSessionsPresentationContext, CHAT_VIEW_ID, TOGGLE_AGENT_SESSIONS_SIDEBAR_COMMAND_ID } from '../../common/chat.js';
import { ChatConfiguration } from '../../common/constants.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import type { IChatViewPane } from '../chat.js';
import { AgentSessionsViewerOrientation } from './agentSessions.js';

export function registerAgentSessionsLayoutActions(): void {
	registerAction2(FocusAgentSessionsAction);
	for (const [orientation, id, title] of [
		['stacked', 'agentSessions.hideAgentSessionsSidebar', localize2('chat.sessions.orientation.stackCommand', 'Stack Agent Sessions Above Chat')],
		['sideBySide', 'agentSessions.showAgentSessionsSidebar', localize2('chat.sessions.orientation.sidebarCommand', 'Show Agent Sessions Sidebar')],
	] as const) {
		registerAction2(class extends Action2 {
			constructor() {
				super({ id, title, precondition: AgentSessionsPresentationContext.isEqualTo(AgentSessionsPresentation.List), f1: true });
			}
			override async run(accessor: ServicesAccessor): Promise<void> {
				const configuration = accessor.get(IConfigurationService);
				const resize = prepareChatResize(accessor);
				const view = await accessor.get(IViewsService).openView<IChatViewPane>(CHAT_VIEW_ID, false);
				if (!view) {
					return;
				}
				const target = orientation === 'sideBySide' ? AgentSessionsViewerOrientation.SideBySide : AgentSessionsViewerOrientation.Stacked;
				const previousDimensions = view.getLastDimensions(target);
				await configuration.updateValue(ChatConfiguration.ChatViewSessionsOrientation, orientation, ConfigurationTarget.USER_LOCAL);
				if (target === AgentSessionsViewerOrientation.SideBySide && view.getSessionsViewerOrientation() !== target) {
					view.toggleSessionsSidebar();
				}
				resize(view, target, previousDimensions?.width);
			}
		});
	}


	registerAction2(class ToggleAgentSessionsSidebarAction extends Action2 {
		constructor() {
			super({
				id: TOGGLE_AGENT_SESSIONS_SIDEBAR_COMMAND_ID,
				title: localize2('chat.sessions.showSidebar', 'Show Agent Sessions'),
				tooltip: localize('chat.sessions.showSidebar', 'Show Agent Sessions'),
				icon: Lxicon.layoutSidebarRightOff1,
				toggled: {
					condition: ChatContextKeys.agentSessionsViewerOrientation.isEqualTo(AgentSessionsViewerOrientation.SideBySide),
					title: localize('chat.sessions.hideSidebar', 'Hide Agent Sessions'),
					tooltip: localize('chat.sessions.hideSidebar', 'Hide Agent Sessions'),
					icon: Lxicon.layoutSidebarRight1,
				},
				menu: [
					{
						id: MenuId.ChatTitleLayout,
						group: 'navigation',
						order: 1,
					},
				],
				f1: true,
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const configuration = accessor.get(IConfigurationService);
			const resize = prepareChatResize(accessor);
			const view = await accessor.get(IViewsService).openView<IChatViewPane>(CHAT_VIEW_ID, false);
			if (!view) {
				return;
			}
			const target = view.getSessionsViewerOrientation() === AgentSessionsViewerOrientation.SideBySide
				? AgentSessionsViewerOrientation.Stacked : AgentSessionsViewerOrientation.SideBySide;
			// Capture the target's last geometry before visibility or configuration can relayout it.
			const previousDimensions = view.getLastDimensions(target);
			if (target === AgentSessionsViewerOrientation.SideBySide) {
				await configuration.updateValue(ChatConfiguration.ChatViewSessionsOrientation, 'sideBySide', ConfigurationTarget.USER_LOCAL);
			}
			// Reveal and resize together so a settings write cannot expose the stacked layout.
			view.toggleSessionsSidebar({ visible: target === AgentSessionsViewerOrientation.SideBySide });
			resize(view, target, previousDimensions?.width);
		}
	});

}

export class FocusAgentSessionsAction extends Action2 {
	public static readonly id = 'workbench.action.chat.focusAgentSessionsViewer';

	constructor() {
		super({
			id: FocusAgentSessionsAction.id,
			title: localize2('chat.focusAgentSessionsViewer.label', 'Focus Agent Sessions'),
			precondition: ChatContextKeys.enabled.isEqualTo(true),
			f1: true,
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const view = await accessor.get(IViewsService).openView<IChatViewPane>(CHAT_VIEW_ID, true);
		if (!view || view.focusSessions()) {
			return;
		}
		view.toggleSessionsSidebar({ visible: true });
		view.focusSessions();
	}
}

/** Capture invocation-scoped services before opening the view or saving configuration. */
function prepareChatResize(accessor: ServicesAccessor): (view: IChatViewPane, orientation: AgentSessionsViewerOrientation, previousContentWidth: number | undefined) => void {
	const contextKeys = accessor.get(IContextKeyService);
	const descriptors = accessor.get(IViewDescriptorService);
	const layout = accessor.get(IWorkbenchLayoutService);
	const paneComposites = accessor.get(IPaneCompositePartService);
	return (view, orientation, previousContentWidth): void => {
		if (contextKeys.getValue<boolean>('chatInEditor')) {
			return;
		}
		const container = descriptors.getViewContainerForView(CHAT_VIEW_ID);
		const location = container ? descriptors.getViewContainerLocation(container) : null;
		if (location === null) {
			return;
		}
		// A horizontal Panel shares its width with the editor and cannot be widened independently.
		if (location === ViewContainerLocation.Panel && isHorizontal(layout.getPanelPosition())) {
			return;
		}
		const part = paneComposites.getPartId(location);
		let size = layout.getPartSize(part);
		const paneWidth = view.element.getBoundingClientRect().width;
		const frameWidth = paneWidth > 0 ? Math.max(0, size.width - paneWidth) : 0;
		// The view owns its preferred content width; the Part adds its frame insets.
		const sideBySide = orientation === AgentSessionsViewerOrientation.SideBySide;
		const minimumWidth = view.getOptimalWidth() + frameWidth + 1;
		if (sideBySide && size.width >= minimumWidth) {
			return;
		}
		// Maximization belongs to the Workbench; closing the inner sidebar keeps that state.
		if (!sideBySide && part === 'auxiliarybar' && layout.isAuxiliaryBarMaximized()) {
			return;
		}
		if (part === 'auxiliarybar' && layout.isAuxiliaryBarMaximized()) {
			layout.setAuxiliaryBarMaximized(false);
			size = layout.getPartSize(part);
		}
		const previousWidth = previousContentWidth === undefined ? undefined : previousContentWidth + frameWidth;
		const width = sideBySide
			? Math.max(minimumWidth, previousWidth ?? layout.mainContainerDimension.width / 2)
			: previousWidth ?? Math.max(view.getOptimalWidth() + frameWidth, size.width - view.getOptimalWidth());
		layout.resizePart(part, new Dimension(width, size.height));
		if (sideBySide && part === 'auxiliarybar' && layout.getPartSize(part).width < minimumWidth) {
			layout.setAuxiliaryBarMaximized(true);
		}
	};
}
