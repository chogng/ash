import { Lxicon } from "../../../base/common/lxicons.js";
import { Action2, MenuId, registerAction2 } from "../../../platform/actions/common/actions.js";
import type { ISessionsWindowApi } from "../../common/sessionsWindow.js";
import { ILayoutService } from "../../../platform/layout/browser/layoutService.js";
import type { ServicesAccessor } from "../../../platform/instantiation/common/instantiation.js";
import { navigateToSessionsPage } from "./sessionNavigation.js";

export type SessionsTitlebarDestination =
	| { readonly kind: "page"; readonly relativePath: string }
	| { readonly kind: "window"; readonly sessionsWindowApi: ISessionsWindowApi };

/** Adds the product's dedicated Sessions entry to the existing Workbench titlebar. */
export function registerSessionsTitlebarEntry(actionId: string, title: string, destination: SessionsTitlebarDestination): void {
	registerAction2(class OpenSessionsAction extends Action2 {
		constructor() {
			super({
				id: actionId,
				title,
				tooltip: title,
				icon: Lxicon.chat,
				menu: {
					id: MenuId.TitleBarLeft,
					group: "navigation",
					order: 1,
				},
				f1: true,
			});
		}

		override run(accessor: ServicesAccessor): void | Promise<void> {
			if (destination.kind === "window") {
				return destination.sessionsWindowApi.openSessionsWindow();
			}
			navigateToSessionsPage(destination.relativePath, accessor.get(ILayoutService).activeContainer.ownerDocument.location);
		}
	});
}
