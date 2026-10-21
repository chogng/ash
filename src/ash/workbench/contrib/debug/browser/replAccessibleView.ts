import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, type IAccessibleViewContentProvider } from '../../../../platform/accessibility/browser/accessibleView.js';
import type { IAccessibleViewImplementation } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { getReplView } from './repl.js';

/** Borrows the console view; output, input and focus remain owned by Repl. */
export class ReplAccessibleView implements IAccessibleViewImplementation {
	public readonly type = AccessibleViewType.View;
	public readonly priority = 110;
	public readonly name = 'debug.repl.view';

	public getProvider(accessor: ServicesAccessor): IAccessibleViewContentProvider | undefined {
		const view = getReplView(accessor.get(IViewsService));
		const focused = view?.element.ownerDocument.activeElement as HTMLElement | null;
		if (!view || !focused || !view.element.contains(focused)) {
			return undefined;
		}
		const provider = new AccessibleContentProvider(AccessibleViewProviderId.Repl, { type: this.type },
			() => view.getVisibleContent(),
			() => {
				if (focused.isConnected) {
					focused.focus();
				} else {
					view.focus();
				}
			}, AccessibilityVerbositySettingId.DebugConsole);
		provider.onDidChangeContent = view.onDidChangeContent;
		return provider;
	}
}
