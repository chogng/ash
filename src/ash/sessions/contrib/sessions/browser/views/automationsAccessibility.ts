import { getActiveElement } from '../../../../../base/browser/dom.js';
import { DisposableStore, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { getNLSLanguage, localize } from '../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IAutomationService } from '../../../../../workbench/contrib/chat/common/automations/automationService.js';
import type { IAutomationRun } from '../../../../../workbench/contrib/chat/common/automations/automation.js';
import { getAutomationCatalogueMessage } from './automationCataloguePresentation.js';
import { automationRunWithLocalProgress } from './automationRunProgress.js';
import { IChatWidgetService } from '../../../../../workbench/contrib/chat/browser/chat.js';
import { ISessionProviderScopeService } from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../../common/agentHostSessionsProvider.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { belongsToAutomationView } from '../automationsConstants.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Automations,
	defaultValue: true,
	parse: value => {
		if (typeof value !== 'boolean') throw new TypeError(localize('automations.verbosityInvalid', 'Task accessibility verbosity must be a boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('automations.verbosityTitle', 'Scheduled and Routines accessibility help'),
		description: localize('automations.verbosityDescription', 'Announce keyboard help when Scheduled or Routines controls receive focus.')
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
			const container = accessor.get(ILayoutService).activeContainer;
			const chatWidgets = type === AccessibleViewType.View ? accessor.get(IChatWidgetService) : undefined;
			const providerScopes = type === AccessibleViewType.View ? accessor.get(ISessionProviderScopeService) : undefined;
			const focused = getActiveElement(container.ownerDocument) as HTMLElement | undefined;
			const kind = focused?.closest('[data-automation-kind="chat"]') ? 'chat' : 'code';
			const chatStore = kind === 'chat' ? accessor.get(ISessionsProvidersService).getProvider(LOCAL_AGENT_HOST_PROVIDER_ID)?.automations : undefined;
			return new AccessibleContentProvider(AccessibleViewProviderId.Automations, { type }, () => type === AccessibleViewType.Help
				? kind === 'chat'
					? localize('scheduled.help', 'Open Scheduled from the Chat Activity Bar. Tab and Shift+Tab move between New scheduled task, search, filters, tasks, and run history. Each task opens its details. Run now starts a separate Ash Chat conversation. Pause stops future scheduled runs. Open conversation in run history takes you to Ash Chat. Back returns to the task list. If loading fails, use Retry. <keybinding:editor.action.accessibleView> reads tasks and run history.')
					: localize('automations.cardsHelp', 'In Code, choose Routines under More in the Activity Bar to open plans and run history. Search by name, instructions, or directory. All, Enabled, and Paused filter the plans; Clear filters restores all plans. Empty-state templates open editable drafts and create nothing until you save. The overview shows enabled and paused plans and runs that need input. Each card shows instructions, schedule, next run, and working directory. Tab and Shift+Tab move between cards and actions. Select a routine name to open its details. Each run opens its recorded version, times, output, and file changes. Back restores the list and focus. Edit routine opens the form with host-calculated schedule previews. Duplicate opens a paused draft. Needs attention lists waiting runs and the latest failed run. Completion notifications are optional; View result in a notification opens run details. Run now requests execution on the owning provider. Pause prevents future scheduled runs; Stop run interrupts a current run. Opening a conversation returns to the retained Sessions view. Back and Forward navigate between conversations and Routines. If loading fails, use Retry. Closing this view or window leaves enabled schedules running on their host. <keybinding:editor.action.accessibleView> reads plans and run history.') + ' ' + localize('automations.hostHelp', 'When plans come from multiple hosts, each card identifies its host. Select Run on before choosing a directory or conversation. Changing hosts clears the previous directory and conversation. Only conversations from the selected host are offered.')
				: container.querySelector<HTMLElement>('.ash-automation-details:not([hidden])')?.innerText ?? [
					getAutomationCatalogueMessage(kind === 'chat' ? chatStore?.catalogueState.get() ?? 'unavailable' : automations.catalogueState.get(), kind),
					...((kind === 'chat' ? chatStore?.historyState?.get() : automations.historyState?.get()) === 'error' ? [localize('automations.historyRefreshFailed', 'Could not load run history. Showing the last available history.')] : []),
					...automations.automations.get().filter(plan => belongsToAutomationView(plan.target, kind)).map(plan => {
						const state = plan.enabled ? localize('automations.enabled', 'Enabled') : localize('automations.paused', 'Paused');
						if (kind === 'chat') return localize('scheduled.planSummary', '{0} · {1} · {2}', plan.name, state, plan.prompt);
						const host = automations.availableProviders.get().find(provider => provider.id === plan.target.providerId)?.label ?? localize('automations.hostOffline', 'Host unavailable');
						return localize('automations.planSummary', '{0} · {1} · {2} · {3}', localize('automations.hostedTitle', '{0} · {1}', plan.name, host), state, plan.target.directory, plan.prompt);
					}),
					...automations.runs.get().filter(run => belongsToAutomationView(run.definition.target, kind)).map(run => {
						const widgets = chatWidgets!.getAllWidgets();
						const scope = widgets.length ? providerScopes!.getScopes().find(scope => scope.providerId === run.providerId) : undefined;
						const display = automationRunWithLocalProgress(run, widgets, scope);
						return `${new Date(display.scheduledAt).toLocaleString(getNLSLanguage())} · ${automationRunStatusLabel(display.status)}${display.message ? ` · ${display.message}` : ''}`;
					}),
				].filter(Boolean).join('\n'), () => focused?.focus(), AccessibilityVerbositySettingId.Automations);
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
