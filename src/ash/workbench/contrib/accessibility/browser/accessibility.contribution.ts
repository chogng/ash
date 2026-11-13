import './accessibilityConfiguration.js';
import './accessibleViewActions.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { BannerFocused } from '../../../common/contextkeys.js';
import { IBannerService } from '../../../services/banner/browser/bannerService.js';
import { isHTMLElement } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { stripIcons } from '../../../../base/common/iconLabels.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IQuickInputService, QuickInputType, type IQuickPick, type IQuickPickItem, type IQuickTree, type IQuickTreeItem } from '../../../../platform/quickinput/common/quickInput.js';
import { quickInputTypeContextKey } from '../../../../platform/quickinput/browser/quickInput.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { localize } from '../../../../nls.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { AccessibleViewService } from './accessibleView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorAccessibilityHelpContribution } from './editorAccessibilityHelp.js';
import { UnfocusedViewDimmingContribution } from './unfocusedViewDimmingContribution.js';

registerSingleton(IAccessibleViewService, AccessibleViewService, InstantiationType.Delayed);

registerWorkbenchContribution('workbench.contrib.quickInputAccessibility', WorkbenchPhase.AfterRestored, accessor => {
	const inputs = accessor.get(IQuickInputService);
	const views = accessor.get(IAccessibleViewService);
	const configuration = accessor.get(IConfigurationService);
	const layout = accessor.get(ILayoutService);
	const resources = new DisposableStore();
	const update = (): void => {
		const field = layout.activeContainer.querySelector<HTMLInputElement>('.ash-quick-input-host input[role="combobox"]');
		const hint = views.getOpenAriaHint(AccessibilityVerbositySettingId.QuickInput);
		if (hint) field?.setAttribute('aria-description', hint);
		else field?.removeAttribute('aria-description');
	};
	resources.add(inputs.onShow(update));
	resources.add(configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(AccessibilityVerbositySettingId.QuickInput)) update(); }));
	return resources;
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 110, name: `quick-input-${type}`,
		when: ContextKeyExpr.or(quickInputTypeContextKey.isEqualTo(QuickInputType.QuickTree), quickInputTypeContextKey.isEqualTo(QuickInputType.QuickPick)),
		getProvider: accessor => {
			const input = accessor.get(IQuickInputService).currentQuickInput;
			if (!input || input.type !== QuickInputType.QuickTree && input.type !== QuickInputType.QuickPick) return undefined;
			const layout = accessor.get(ILayoutService);
			const focused = layout.activeContainer.ownerDocument.activeElement;
			const tree = input.type === QuickInputType.QuickTree ? input as IQuickTree<IQuickTreeItem> : undefined;
			const picker = input.type === QuickInputType.QuickPick ? input as IQuickPick<IQuickPickItem> : undefined;
			const provider = new AccessibleContentProvider(AccessibleViewProviderId.QuickInput, { type }, () => {
				if (type === AccessibleViewType.Help) return tree
					? localize('quickTree.accessibilityHelp', 'Quick Tree\nType to filter. Up and Down move into the tree and return to the search field at either end. Tab moves through links, the tree and item actions. In the tree, Left and Right collapse or expand groups, and Space toggles the focused item and its children. Use <keybinding:quickInput.toggleCheckbox> to toggle from the search field. Select all also changes hidden items. Enter or Apply accepts the selection. Escape discards it and returns focus to the previous control.')
					: localize('quickInput.accessibilityHelp', 'Quick Pick\nType to filter. Up and Down browse results; Enter accepts. Tab moves to item actions, including Pin item and Unpin item when available. Pinned items appear above other results when search is empty. Escape closes the picker and restores focus.');
				if (tree) {
					const describe = (items: readonly IQuickTreeItem[], depth = 0): string[] => items.flatMap(item => {
						const state = item.disabled ? localize('quickTree.disabled', 'Unavailable')
							: item.checked === 'mixed' ? localize('quickTree.mixed', 'Partly selected')
								: item.checked ? localize('quickTree.checked', 'Selected') : localize('quickTree.unchecked', 'Not selected');
						const label = localize('quickTree.accessibleItem', '{0}: {1}', stripIcons(item.label), state);
						const details = [item.description, item.detail].filter((value): value is string => !!value)
							.map(value => `${'  '.repeat(depth + 1)}${stripIcons(value)}`);
						return [`${'  '.repeat(depth)}${label}`, ...details, ...describe(item.children ?? [], depth + 1)];
					});
					return describe(tree.itemTree).join('\n');
				}
				return picker!.items.map(item => [item.label, 'description' in item ? item.description : undefined].filter(Boolean).join(', ')).join('\n');
			}, () => {
				if (isHTMLElement(focused) && focused.isConnected) focused.focus();
				else input.focus();
			}, AccessibilityVerbositySettingId.QuickInput);
			if (tree) provider.onDidChangeContent = Event.any(Event.map(tree.onDidChangeCheckedLeafItems, () => undefined), Event.map(tree.onDidChangeValue, () => undefined));
			return provider;
		},
	});
}

registerWorkbenchContribution(EditorAccessibilityHelpContribution.ID, WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(EditorAccessibilityHelpContribution));
registerWorkbenchContribution('workbench.contrib.unfocusedViewDimming', WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(UnfocusedViewDimmingContribution));

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
				AccessibleViewProviderId.Banner, { type },
				() => {
					if (type === AccessibleViewType.Help) {
						return localize('banner.accessibilityHelp', 'Window Banner\nBanners show persistent window status, including Agent Host connection recovery. Use Tab and Shift+Tab or the arrow keys to move between actions and Close Banner. Press Enter or Space to activate an action. Escape focuses the banner message without dismissing it. Manage opens Workspace Trust for the current workspace. Changes require saving and confirmation. Close Banner dismisses the notice. Focus Banner in the Command Palette returns here. Press <keybinding:editor.action.accessibleView> to read the full message. When Agent Host recovery fails, Reconnect tries again without resending an unfinished message. Agent Host: Reconnect is also available in the Command Palette. If authorization expired, open a new authenticated link.');
					}
					const message = region.querySelector('.ash-banner-message')?.textContent?.trim();
					const actions = [...region.querySelectorAll<HTMLElement>('a, button')]
						.map(action => action.textContent || action.getAttribute('aria-label'));
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
