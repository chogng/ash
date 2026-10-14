import { getActiveElement } from '../../../../../base/browser/dom.js';
import { DisposableStore, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IAutomationService } from '../../../../../workbench/contrib/chat/common/automations/automationService.js';
import type { IAutomationRun } from '../../../../../workbench/contrib/chat/common/automations/automation.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Automations,
	defaultValue: true,
	parse: value => {
		if (typeof value !== 'boolean') throw new TypeError(localize('automations.verbosityInvalid', 'Automations accessibility verbosity must be a boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('automations.verbosityTitle', 'Automations accessibility help'),
		description: localize('automations.verbosityDescription', 'Announce keyboard help when automation controls receive focus.')
	},
});

export function registerAutomationsAccessibility(): IDisposable {
	const registrations = new DisposableStore();
	for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) registrations.add(AccessibleViewRegistry.register({
		type,
		priority: 100,
		name: `sessionsAutomations${type}`,
		when: type === AccessibleViewType.Help ? ContextKeyExpr.or(ContextKeyExpr.has('sessionsAutomationsFocused'), ContextKeyExpr.has('sessionsAutomationDialogFocused')) : ContextKeyExpr.has('sessionsAutomationsFocused'),
		getProvider: accessor => {
			const automations = accessor.get(IAutomationService);
			const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement | undefined;
			return new AccessibleContentProvider(AccessibleViewProviderId.Automations, { type }, () => type === AccessibleViewType.Help
				? localize('automations.cardsHelp', 'Open this view with Manage Automations in the Sessions sidebar. Tab and Shift+Tab move between cards and actions. New automation and each automation name open an editing dialog. Run now requests execution on the owning provider. Pause prevents future scheduled runs; Stop run interrupts a current run. Opening a conversation returns to the retained Sessions view. Back and Forward navigate between conversations and Automations. Refresh retries loading run history without repeating saved changes. Closing this view or window leaves enabled schedules running on their host. <keybinding:editor.action.accessibleView> reads plans and run history.')
				: [
					...(automations.historyState?.get() === 'error' ? [localize('automations.historyRefreshFailed', 'Run history could not be refreshed. Showing the last available history. Use Refresh to try again.')] : []),
					...automations.automations.get().map(plan => localize('automations.planSummary', '{0} · {1} · {2}', plan.name, plan.enabled ? localize('automations.enabled', 'Enabled') : localize('automations.paused', 'Paused'), plan.target.directory)),
					...automations.runs.get().map(run => `${new Date(run.scheduledAt).toLocaleString()} · ${automationRunStatusLabel(run.status)}${run.message ? ` · ${run.message}` : ''}`),
				].join('\n'), () => focused?.focus(), AccessibilityVerbositySettingId.Automations);
		},
	}));
	return registrations;
}

export function automationRunStatusLabel(status: IAutomationRun['status']): string {
	return {
		pending: localize('automations.runStatus.pending', 'Pending'),
		running: localize('automations.runStatus.running', 'Running'),
		needsInput: localize('automations.runStatus.needsInput', 'Needs input'),
		stopping: localize('automations.runStatus.stopping', 'Stopping'),
		completed: localize('automations.runStatus.completed', 'Completed'),
		failed: localize('automations.runStatus.failed', 'Failed'),
		stopped: localize('automations.runStatus.stopped', 'Stopped'),
		skipped: localize('automations.runStatus.skipped', 'Skipped'),
	}[status];
}
