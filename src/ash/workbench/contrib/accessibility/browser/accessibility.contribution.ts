import './accessibilityConfiguration.js';
import './accessibleViewActions.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
	IAccessibleViewService,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { BannerFocused } from '../../../common/contextkeys.js';
import { IBannerService } from '../../../services/banner/browser/bannerService.js';
import { isHTMLElement } from '../../../../base/browser/dom.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AccessibleViewService } from './accessibleView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorAccessibilityHelpContribution } from './editorAccessibilityHelp.js';
import { AccessibilityStatus } from './accessibilityStatus.js';
import { UnfocusedViewDimmingContribution } from './unfocusedViewDimmingContribution.js';

registerSingleton(IAccessibleViewService, AccessibleViewService, InstantiationType.Delayed);

registerWorkbenchContribution(EditorAccessibilityHelpContribution.ID, WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(EditorAccessibilityHelpContribution),
);
registerWorkbenchContribution(AccessibilityStatus.ID, WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(AccessibilityStatus));
registerWorkbenchContribution('workbench.contrib.unfocusedViewDimming', WorkbenchPhase.AfterRestored, accessor => accessor.get(IInstantiationService).createInstance(UnfocusedViewDimmingContribution));

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		priority: 100,
		name: `banner-${type}`,
		when: BannerFocused.isEqualTo(true),
		getProvider: accessor => {
			const layout = accessor.get(ILayoutService);
			const banners = accessor.get(IBannerService);
			const region = layout.mainContainer.querySelector<HTMLElement>('[data-part="banner"]:not([hidden])');
			if (!region) return undefined;
			const focused = region.ownerDocument.activeElement;
			const provider = new AccessibleContentProvider(
				AccessibleViewProviderId.Banner,
				{ type },
				() => {
					if (type === AccessibleViewType.Help) {
						return localize(
							'banner.accessibilityHelp',
							'Window Banner\nBanners show persistent window status, including Agent Host connection recovery. Use Tab and Shift+Tab or the arrow keys to move between actions and Close Banner. Press Enter or Space to activate an action. Escape focuses the banner message without dismissing it. Manage opens Workspace Trust for the current workspace. Changes require saving and confirmation. Close Banner dismisses the notice. Focus Banner in the Command Palette returns here. Press <keybinding:editor.action.accessibleView> to read the full message. When Agent Host recovery fails, Reconnect tries again without resending an unfinished message. Agent Host: Reconnect is also available in the Command Palette. If authorization expired, open a new authenticated link.',
						);
					}
					const message = region.querySelector('.ash-banner-message')?.textContent?.trim();
					const actions = [...region.querySelectorAll<HTMLElement>('a, button')].map(action => action.textContent || action.getAttribute('aria-label'));
					return [message, ...actions].filter(Boolean).join('\n');
				},
				() => {
					if (isHTMLElement(focused) && focused.isConnected && focused.getClientRects().length) focused.focus();
					else if (!region.hidden) banners.focus();
					else layout.focus();
				},
				AccessibilityVerbositySettingId.Banner,
			);
			if (type === AccessibleViewType.View) {
				provider.onDidChangeContent = (listener, thisArgs, disposables) => {
					const observer = new MutationObserver(() => listener.call(thisArgs));
					observer.observe(region, { childList: true, subtree: true, characterData: true });
					const lifetime = toDisposable(() => observer.disconnect());
					if (Array.isArray(disposables)) disposables.push(lifetime);
					else disposables?.add(lifetime);
					return lifetime;
				};
			}
			return provider;
		},
	});
}
