import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Menus } from '../../../../browser/menus.js';
import { ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import { AUTOMATIONS_CUSTOM_VIEW_ID } from '../automationsConstants.js';
import { automationRunStatusLabel, registerAutomationsAccessibility } from './automationsAccessibility.js';
import { addDisposableListener, getActiveElement, h, isHTMLElement } from '../../../../../base/browser/dom.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputbox.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, autorun, observableSignalFromEvent, observableValue, transaction } from '../../../../../base/common/observable.js';
import { getNLSLanguage, localize, localize2 } from '../../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { Severity, INotificationService, type INotificationHandle } from '../../../../../platform/notification/common/notification.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { IAutomationDescriptor, IAutomationRun, IAutomationSchedule } from '../../../../../workbench/contrib/chat/common/automations/automation.js';
import { IAutomationService } from '../../../../../workbench/contrib/chat/common/automations/automationService.js';
import { IAutomationDialogService } from '../../../../../workbench/contrib/chat/common/automations/automationDialogService.js';
import { IAutomationRunner } from '../../../../../workbench/contrib/chat/common/automations/automationRunner.js';
import { IChatSessionNavigationService } from '../../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { AbstractCustomView } from '../../../../services/customView/browser/customView.js';
import '../media/automationsCards.css';

interface PlanCard {
	readonly lifetime: DisposableStore;
	readonly element: HTMLElement;
	readonly title: Button;
	readonly state: HTMLElement;
	readonly prompt: HTMLElement;
	readonly schedule: HTMLElement;
	readonly directory: HTMLElement;
	readonly detail: HTMLElement;
	readonly run: Button;
	readonly pause: Button;
	readonly remove: Button;
}

interface RunRow {
	readonly lifetime: DisposableStore;
	readonly element: HTMLElement;
	readonly title: HTMLElement;
	readonly details: Button;
	readonly state: HTMLElement;
	readonly time: HTMLTimeElement;
	readonly text: HTMLElement;
	readonly open: Button;
	readonly stop: Button;
}

type AutomationSelection = { readonly kind: 'plan'; readonly id: string; } | { readonly kind: 'run'; readonly id: string; readonly planId?: string; };

/** Keeps card identity and focus stable while provider-owned snapshots change. */
export class AutomationsCardsWidget extends Disposable {
	readonly element: HTMLElement;
	private readonly plans: HTMLElement;
	private readonly history: HTMLElement;
	private readonly message: HTMLElement;
	private readonly search: InputBox;
	private readonly templates: readonly Button[];
	private readonly query = observableValue(this, '');
	private readonly filter = observableValue<'all' | 'enabled' | 'paused'>(this, 'all');
	private readonly cards = new Map<string, PlanCard>();
	private readonly rows = new Map<string, RunRow>();
	private readonly pending = new Set<string>();
	private readonly pendingChanged = observableValue(this, 0);
	private readonly selection = observableValue<AutomationSelection | undefined>(this, undefined);
	private readonly detailLifetime = this._register(new MutableDisposable<DisposableStore>());
	private readonly details: HTMLElement;
	private readonly attention: HTMLElement;
	private readonly attentionItems = new Map<string, Button>();
	private returnFocus: HTMLElement | undefined;

	constructor(container: HTMLElement,
		@IAutomationService private readonly automations: IAutomationService,
		@IAutomationDialogService private readonly dialogs: IAutomationDialogService,
		@IAutomationRunner private readonly runner: IAutomationRunner,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@IContextKeyService contexts: IContextKeyService,
		@IConfigurationService configuration: IConfigurationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		const document = container.ownerDocument;
		this.element = h(document, 'section', { className: 'ash-automations', attributes: { 'aria-label': localize('automations.title', 'Automations') }, properties: { tabIndex: -1 } });
		this._register(contexts.createScoped(this.element)).createKey('sessionsAutomationsFocused', true);
		this.message = h(document, 'p', { className: 'ash-automation-notice', attributes: { role: 'status' } });
		const plansSection = h(document, 'section', { className: 'ash-automation-plans-section', attributes: { 'aria-label': localize('automations.plans', 'Your automations') } });
		const plansHeader = h(document, 'div', { className: 'ash-automation-section-heading' });
		const plansHeading = h(document, 'h2', {}, localize('automations.plans', 'Your automations'));
		const summary = h(document, 'p', { className: 'ash-automation-summary' });
		plansHeader.append(plansHeading, summary);
		const controls = h(document, 'div', { className: 'ash-automation-controls' });
		const filters = h(document, 'div', { className: 'ash-automation-filters', attributes: { role: 'group', 'aria-label': localize('automations.filter', 'Filter automations') } });
		const filterButtons = ([
			{ value: 'all', label: localize('automations.all', 'All') },
			{ value: 'enabled', label: localize('automations.enabled', 'Enabled') },
			{ value: 'paused', label: localize('automations.paused', 'Paused') },
		] as const).map(item => {
			const button = this._register(new Button(filters, {
				...defaultButtonStyles,
				label: item.label,
				checked: item.value === 'all',
				onClick: () => this.filter.set(item.value, undefined),
			}));
			return { value: item.value, button };
		});
		const search = h(document, 'div', { className: 'ash-automation-search' });
		appendIcon(Lxicon.search, search);
		this.search = this._register(new InputBox(search, {
			inputBoxStyles: defaultInputBoxStyles,
			type: 'search',
			ariaLabel: localize('automations.search', 'Search automations'),
			placeholder: localize('automations.search', 'Search automations'),
		}));
		this._register(this.search.onDidChange(value => this.query.set(value, undefined)));
		controls.append(filters, search);
		this.plans = h(document, 'div', { className: 'ash-automation-cards' });
		const empty = h(document, 'div', { className: 'ash-automation-empty' });
		const emptyIcon = h(document, 'div', { className: 'ash-automation-empty-icon' });
		appendIcon(Lxicon.clockface, emptyIcon);
		empty.append(emptyIcon,
			h(document, 'h3', {}, localize('automations.emptyTitle', 'Create your first automation')),
			h(document, 'p', {}, localize('automations.emptyDescription', 'Give your agent a task and a schedule. Start from a template, or create your own.')));
		this.templates = this.createTemplates(empty);
		const noMatches = h(document, 'div', { className: 'ash-automation-no-matches' });
		noMatches.append(h(document, 'p', { attributes: { role: 'status' } }, localize('automations.noMatches', 'No automations match your filters.')));
		this._register(new Button(noMatches, {
			...defaultButtonStyles,
			label: localize('automations.clearFilters', 'Clear filters'),
			onClick: () => {
				this.search.value = '';
				transaction(tx => { this.query.set('', tx); this.filter.set('all', tx); });
				this.search.focus();
			},
		}));
		plansSection.append(plansHeader, controls, empty, this.plans, noMatches);
		const historySection = h(document, 'section', { className: 'ash-automation-history-section', attributes: { 'aria-label': localize('automations.history', 'Run history') } });
		const historyHeader = h(document, 'div', { className: 'ash-automation-section-heading' });
		const heading = h(document, 'h2', {}, localize('automations.history', 'Run history'));
		historyHeader.append(heading, h(document, 'p', { className: 'ash-automation-section-description' }, localize('automations.historyHint', 'Review results and pick up where your agent left off.')));
		const historyMessage = h(document, 'p', { className: 'ash-automation-notice', attributes: { role: 'status' } });
		const historyEmpty = h(document, 'p', { className: 'ash-automation-empty-history' }, localize('automations.emptyHistory', 'No runs yet. Run an automation now or wait for its next scheduled time.'));
		this.history = h(document, 'div', { className: 'ash-automation-history' });
		historySection.append(historyHeader, historyMessage, historyEmpty, this.history);
		const overview = h(document, 'div', { className: 'ash-automation-overview' });
		const notificationPreference = h(document, 'label', { className: 'ash-automation-notification-preference' });
		const notifySuccess = h(document, 'input', { properties: { type: 'checkbox' } });
		notificationPreference.append(notifySuccess, h(document, 'span', {}, localize('automations.notifySuccess', 'Notify when an automation completes')));
		const configurationChanged = observableSignalFromEvent(this, configuration.onDidChangeConfiguration);
		this._register(autorun(reader => {
			configurationChanged.read(reader);
			notifySuccess.checked = configuration.getValue<boolean>('sessions.automations.notifyOnSuccess') === true;
		}));
		this._register(addDisposableListener(notifySuccess, 'change', () => {
			void configuration.updateValue('sessions.automations.notifyOnSuccess', notifySuccess.checked).catch(error => this.notifications.error(String(error)));
		}));
		this.attention = h(document, 'section', { className: 'ash-automation-attention', attributes: { 'aria-label': localize('automations.attention', 'Needs attention') } });
		this.attention.append(h(document, 'h2', {}, localize('automations.attention', 'Needs attention')));
		this.details = h(document, 'section', { className: 'ash-automation-details', attributes: { 'aria-label': localize('automations.details', 'Automation details') } });
		overview.append(this.attention, plansSection, historySection, notificationPreference);
		this.element.append(this.message, overview, this.details);
		this._register(autorun(reader => {
			const selected = this.selection.read(reader);
			overview.hidden = !!selected;
			this.details.hidden = !selected;
			this.renderDetails(selected);
		}));
		this._register(CommandsRegistry.register('sessions.automations.openRun', (_accessor, id) => {
			if (typeof id === 'string' && this.automations.runs.get().some(run => run.id === id)) this.openDetails({ kind: 'run', id });
		}));
		this._register(addDisposableListener(this.element, 'focusin', event => {
			if (!this.element.contains(event.relatedTarget as Node) && configuration.getValue<boolean>(AccessibilityVerbositySettingId.Automations)) status(localize('automations.helpHint', 'Press Alt+F1 for Automations keyboard help.'));
		}));
		this._register(toDisposable(() => {
			for (const card of this.cards.values()) card.lifetime.dispose();
			for (const row of this.rows.values()) row.lifetime.dispose();
			for (const button of this.attentionItems.values()) button.dispose();
			this.element.remove();
		}));
		this._register(autorun(reader => {
			const plans = automations.automations.read(reader);
			const runs = automations.runs.read(reader);
			const state = automations.catalogueState.read(reader);
			const historyState = automations.historyState?.read(reader);
			this.query.read(reader);
			const filter = this.filter.read(reader);
			const canCreate = automations.availableProviders.read(reader).length > 0;
			for (const template of this.templates) template.enabled = canCreate;
			for (const item of filterButtons) item.button.checked = filter === item.value;
			historyMessage.textContent = historyState === 'error'
				? localize('automations.historyRefreshFailed', 'Run history could not be refreshed. Showing the last available history. Use Refresh to try again.') : '';
			historyMessage.hidden = !historyMessage.textContent;
			this.message.textContent = state === 'loading' ? localize('automations.loading', 'Loading automations…')
				: state === 'error' ? localize('automations.loadFailed', 'Could not load automations.')
					: state === 'unavailable' ? localize('automations.unavailable', 'The owning automation host is unavailable. Saved results may be out of date.')
						: '';
			this.message.hidden = !this.message.textContent;
			empty.hidden = state !== 'ready' || plans.length > 0;
			controls.hidden = plans.length === 0;
			historyEmpty.hidden = state !== 'ready' || (historyState !== undefined && historyState !== 'ready') || runs.length > 0;
			summary.textContent = localize('automations.overview', '{0} enabled · {1} paused · {2} need input',
				plans.filter(plan => plan.enabled).length, plans.filter(plan => !plan.enabled).length, runs.filter(run => run.status === 'needsInput').length);
			summary.hidden = plans.length === 0 && runs.length === 0;
			this.element.setAttribute('aria-busy', String(state === 'loading'));
			this.updatePlans(plans);
			noMatches.hidden = plans.length === 0 || [...this.cards.values()].some(card => !card.element.hidden);
			this.updateRuns(runs);
			this.updateAttention(runs);
		}));
	}

	focus(): void {
		if (this.selection.get()) this.details.querySelector<HTMLElement>('h2')?.focus();
		else if (this.cards.size) this.search.focus();
		else {
			const template = this.templates.find(button => button.enabled && !button.domNode.closest('[hidden]'));
			if (template) template.focus();
			else this.element.focus();
		}
	}

	private createTemplates(container: HTMLElement): readonly Button[] {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const templates = [
			{ name: localize('automations.template.briefing', 'Daily briefing'), prompt: localize('automations.template.briefingPrompt', 'Review recent activity in this project. Summarize progress, flag blockers, and suggest the next priorities.'), weekdays: [1, 2, 3, 4, 5, 6, 7], hour: 9, icon: Lxicon.calendar },
			{ name: localize('automations.template.review', 'Review changes'), prompt: localize('automations.template.reviewPrompt', 'Review recent code changes for bugs and missing tests. Summarize actionable findings with file references.'), weekdays: [1, 2, 3, 4, 5], hour: 18, icon: Lxicon.code },
			{ name: localize('automations.template.recap', 'Weekly recap'), prompt: localize('automations.template.recapPrompt', 'Summarize this week’s project activity, completed work, and unresolved questions. Suggest priorities for next week.'), weekdays: [5], hour: 17, icon: Lxicon.check },
		];
		const grid = h(container.ownerDocument, 'div', { className: 'ash-automation-templates' });
		container.append(grid);
		return templates.map(template => {
			const item = h(container.ownerDocument, 'div', { className: 'ash-automation-template' });
			grid.append(item);
			const schedule: IAutomationSchedule = { type: 'weekly', timezone, weekdays: template.weekdays, hour: template.hour, minute: 0 };
			const button = this._register(new Button(item, {
				...defaultButtonStyles,
				label: template.name,
				icon: template.icon,
				onClick: () => { void this.perform('template', () => this.dialogs.showAutomationDialog({ initialValues: { name: template.name, prompt: template.prompt, schedule } })); },
			}));
			item.append(h(container.ownerDocument, 'p', {}, this.scheduleLabel(schedule)));
			return button;
		});
	}

	private updatePlans(plans: readonly IAutomationDescriptor[]): void {
		const providers = this.automations.availableProviders.get();
		const multipleHosts = new Set(plans.map(plan => plan.target.providerId)).size > 1;
		const query = this.query.get().trim().toLocaleLowerCase();
		const filter = this.filter.get();
		for (const [id, card] of this.cards) if (!plans.some(plan => plan.id === id)) {
			card.lifetime.dispose();
			this.cards.delete(id);
		}
		for (const plan of plans) {
			let card = this.cards.get(plan.id);
			if (!card) {
				const lifetime = new DisposableStore();
				const element = h(this.element.ownerDocument, 'article', { className: 'ash-automation-card', attributes: { 'data-automation-id': plan.id, 'aria-label': plan.name } });
				const header = h(this.element.ownerDocument, 'div', { className: 'ash-automation-card-header' });
				const heading = h(this.element.ownerDocument, 'h3');
				const state = h(this.element.ownerDocument, 'span', { className: 'ash-automation-state' });
				header.append(heading, state);
				element.append(header);
				const title = lifetime.add(new Button(heading, {
					...defaultButtonStyles,
					label: plan.name,
					presentation: 'quiet',
					onClick: () => this.openDetails({ kind: 'plan', id: plan.id }),
				}));
				const prompt = h(this.element.ownerDocument, 'p', { className: 'ash-automation-prompt' });
				const schedule = h(this.element.ownerDocument, 'p', { className: 'ash-automation-schedule' });
				const directory = h(this.element.ownerDocument, 'p', { className: 'ash-automation-directory' });
				const detail = h(this.element.ownerDocument, 'p', { className: 'ash-automation-next' });
				const metadata = h(this.element.ownerDocument, 'div', { className: 'ash-automation-metadata' });
				metadata.append(detail, directory);
				element.append(schedule, prompt, metadata);
				const actions = h(this.element.ownerDocument, 'div', { className: 'ash-automation-card-actions' });
				element.append(actions);
				const run = lifetime.add(new Button(actions, {
					...defaultButtonStyles,
					label: localize('automations.runNow', 'Run now'),
					icon: Lxicon.play,
					presentation: 'secondary',
					onClick: () => {
						const current = this.automations.getAutomation(plan.id);
						if (current) void this.perform(plan.id, () => this.runner.runOnce(current).whenDispatched);
					},
				}));
				const pause = lifetime.add(new Button(actions, {
					...defaultButtonStyles,
					label: '',
					onClick: () => {
						const current = this.automations.getAutomation(plan.id);
						if (current) void this.perform(plan.id, () => this.automations.updateAutomation(plan.id, { enabled: !current.enabled }));
					},
				}));
				const remove = lifetime.add(new Button(actions, {
					...defaultButtonStyles,
					label: localize('automations.delete', 'Delete'),
					icon: Lxicon.trash,
					iconOnly: true,
					title: localize('automations.delete', 'Delete'),
					presentation: 'quiet',
					onClick: () => { void this.perform(plan.id, () => this.automations.deleteAutomation(plan.id)); },
				}));
				lifetime.add(toDisposable(() => element.remove()));
				this.plans.append(element);
				card = { lifetime, element, title, state, prompt, schedule, directory, detail, run, pause, remove };
				this.cards.set(plan.id, card);
			}
			card.title.label = plan.name;
			card.title.setTitle(plan.name);
			const host = providers.find(provider => provider.id === plan.target.providerId)?.label ?? localize('automations.hostOffline', 'Host unavailable');
			card.element.setAttribute('aria-label', multipleHosts ? localize('automations.hostedTitle', '{0} · {1}', plan.name, host) : plan.name);
			card.state.textContent = plan.enabled ? localize('automations.enabled', 'Enabled') : localize('automations.paused', 'Paused');
			card.element.dataset.enabled = String(plan.enabled);
			card.element.hidden = (filter !== 'all' && plan.enabled !== (filter === 'enabled')) || ![plan.name, plan.prompt, plan.target.directory, host].some(value => value.toLocaleLowerCase().includes(query));
			card.prompt.textContent = plan.prompt;
			card.schedule.textContent = this.scheduleLabel(plan.schedule);
			card.directory.textContent = multipleHosts
				? localize('automations.runsOn', 'Runs on {0} in {1}', host, plan.target.directory)
				: localize('automations.runsIn', 'Runs in {0}', plan.target.directory);
			card.directory.title = card.directory.textContent;
			card.detail.textContent = plan.nextRunAt === null ? localize('automations.noScheduledRun', 'No scheduled run') : localize('automations.nextRun', 'Next {0}', new Date(plan.nextRunAt).toLocaleString(getNLSLanguage()));
			card.pause.label = plan.enabled ? localize('automations.pause', 'Pause') : localize('automations.enable', 'Enable');
			const idle = !this.pending.has(plan.id);
			card.pause.enabled = idle && this.automations.canUpdateAutomation(plan.id);
			card.run.enabled = idle && this.automations.canRunAutomation(plan.id);
			card.remove.enabled = idle && this.automations.canDeleteAutomation(plan.id);
		}
		this.orderRows(this.plans, plans.map(plan => this.cards.get(plan.id)!.element));
	}

	private updateRuns(runs: readonly IAutomationRun[]): void {
		const providers = this.automations.availableProviders.get();
		const multipleHosts = new Set(runs.map(run => run.providerId)).size > 1;
		for (const [id, row] of this.rows) if (!runs.some(run => run.id === id)) {
			row.lifetime.dispose();
			this.rows.delete(id);
		}
		for (const run of runs) {
			let row = this.rows.get(run.id);
			if (!row) {
				const lifetime = new DisposableStore();
				const element = h(this.element.ownerDocument, 'div', { className: 'ash-automation-run', attributes: { 'data-run-id': run.id } });
				const content = h(this.element.ownerDocument, 'div', { className: 'ash-automation-run-content' });
				const header = h(this.element.ownerDocument, 'div', { className: 'ash-automation-run-header' });
				const title = h(this.element.ownerDocument, 'h3');
				const details = lifetime.add(new Button(title, {
					...defaultButtonStyles,
					label: '',
					onClick: () => this.openDetails({ kind: 'run', id: run.id }),
				}));
				const state = h(this.element.ownerDocument, 'span', { className: 'ash-automation-state' });
				const time = h(this.element.ownerDocument, 'time');
				const text = h(this.element.ownerDocument, 'p');
				header.append(title, state);
				content.append(header, time, text);
				element.append(content);
				const actions = h(this.element.ownerDocument, 'div', { className: 'ash-automation-card-actions' });
				element.append(actions);
				const open = lifetime.add(new Button(actions, {
					...defaultButtonStyles,
					label: localize('automations.openConversation', 'Open conversation'),
					onClick: () => {
						const current = this.automations.runs.get().find(item => item.id === run.id);
						if (current?.sessionId && current.threadId) void this.perform(run.id, () => this.navigation.openConversation(current.sessionId!, current.threadId!, current.providerId));
					},
				}));
				const stop = lifetime.add(new Button(actions, {
					...defaultButtonStyles,
					label: localize('automations.stopRun', 'Stop run'),
					onClick: () => {
						const current = this.automations.runs.get().find(item => item.id === run.id);
						if (current) void this.perform(run.id, () => this.automations.stopRun(current));
					},
				}));
				lifetime.add(toDisposable(() => element.remove()));
				this.history.append(element);
				row = { lifetime, element, title, details, state, time, text, open, stop };
				this.rows.set(run.id, row);
			}
			const host = providers.find(provider => provider.id === run.providerId)?.label ?? localize('automations.hostOffline', 'Host unavailable');
			const title = multipleHosts ? localize('automations.hostedTitle', '{0} · {1}', run.definition.name, host) : run.definition.name;
			row.details.label = title;
			row.details.domNode.setAttribute('aria-label', localize('automations.viewRun', 'View run: {0}', title));
			row.details.setTitle(title);
			row.state.textContent = automationRunStatusLabel(run.status);
			row.element.dataset.status = run.status;
			row.time.dateTime = new Date(run.scheduledAt).toISOString();
			row.time.textContent = new Date(run.scheduledAt).toLocaleString(getNLSLanguage());
			row.text.textContent = run.message ?? '';
			row.text.hidden = !run.message;
			row.open.label = run.status === 'needsInput' ? localize('automations.continueChat', 'Continue in Chat') : localize('automations.openConversation', 'Open conversation');
			row.open.domNode.hidden = !run.sessionId || !run.threadId;
			row.stop.domNode.hidden = !this.automations.canStopRun(run);
			row.stop.enabled = row.open.enabled = !this.pending.has(run.id);
		}
		this.orderRows(this.history, runs.map(run => this.rows.get(run.id)!.element));
	}

	private updateAttention(runs: readonly IAutomationRun[]): void {
		const latest = new Set<string>();
		const items = runs.filter(run => {
			const first = !latest.has(run.automationId);
			latest.add(run.automationId);
			return run.status === 'needsInput' || first && run.status === 'failed';
		});
		for (const [id, button] of this.attentionItems) if (!items.some(run => run.id === id)) {
			button.dispose();
			this.attentionItems.delete(id);
		}
		for (const run of items) {
			let button = this.attentionItems.get(run.id);
			if (!button) {
				button = new Button(this.attention, {
					...defaultButtonStyles,
					label: '',
					onClick: () => this.openDetails({ kind: 'run', id: run.id }),
				});
				this.attentionItems.set(run.id, button);
			}
			button.label = localize('automations.attentionItem', '{0} · {1}', run.definition.name, automationRunStatusLabel(run.status));
		}
		this.attention.hidden = items.length === 0;
	}

	private openDetails(selection: AutomationSelection): void {
		const focused = getActiveElement(this.element.ownerDocument);
		if (!this.selection.get() && isHTMLElement(focused)) this.returnFocus = focused;
		this.selection.set(selection, undefined);
		this.focus();
	}

	private renderDetails(selected: AutomationSelection | undefined): void {
		this.detailLifetime.clear();
		this.details.replaceChildren();
		if (!selected) return;
		const lifetime = new DisposableStore();
		this.detailLifetime.value = lifetime;
		const document = this.element.ownerDocument;
		lifetime.add(new Button(this.details, {
			...defaultButtonStyles,
			label: selected.kind === 'run' && selected.planId ? localize('automations.backToTask', 'Back to automation') : localize('automations.backToList', 'Back to automations'),
			onClick: () => {
				if (selected.kind === 'run' && selected.planId) this.openDetails({ kind: 'plan', id: selected.planId });
				else {
					this.selection.set(undefined, undefined);
					if (this.returnFocus?.isConnected) this.returnFocus.focus();
					if (!this.returnFocus || getActiveElement(document) !== this.returnFocus) this.focus();
				}
			},
		}));
		const header = h(document, 'div', { className: 'ash-automation-section-heading' });
		const heading = h(document, 'h2', { properties: { tabIndex: -1 } });
		const state = h(document, 'span', { className: 'ash-automation-state' });
		header.append(heading, state);
		const actions = h(document, 'div', { className: 'ash-automation-card-actions' });
		const facts = h(document, 'dl', { className: 'ash-automation-facts' });
		const prompt = h(document, 'p', { className: 'ash-automation-prompt' });
		const notice = h(document, 'p', { className: 'ash-automation-notice', attributes: { role: 'status' } });
		this.details.append(header, actions, notice, facts, h(document, 'h3', {}, localize('automations.instructions', 'Instructions')), prompt);
		const fact = (label: string): HTMLElement => {
			const value = h(document, 'dd');
			const group = h(document, 'div');
			group.append(h(document, 'dt', {}, label), value);
			facts.append(group);
			return value;
		};
		const directory = fact(localize('automations.directory', 'Directory'));
		const schedule = fact(localize('automations.schedule', 'Schedule'));
		const revision = fact(localize('automations.version', 'Task version'));
		if (selected.kind === 'plan') {
			const next = fact(localize('automations.nextRunHeading', 'Next run'));
			const host = fact(localize('automations.provider', 'Run on'));
			const edit = lifetime.add(new Button(actions, {
				...defaultButtonStyles,
				label: localize('automations.edit', 'Edit automation'),
				presentation: 'secondary',
				onClick: () => {
					const plan = this.automations.getAutomation(selected.id);
					if (plan) void this.perform('edit:' + plan.id, () => this.dialogs.showAutomationDialog({ existing: plan }));
				},
			}));
			const run = lifetime.add(new Button(actions, {
				...defaultButtonStyles,
				label: localize('automations.runNow', 'Run now'),
				icon: Lxicon.play,
				onClick: () => {
					const plan = this.automations.getAutomation(selected.id);
					if (plan) void this.perform(plan.id, () => this.runner.runOnce(plan).whenDispatched);
				},
			}));
			const duplicate = lifetime.add(new Button(actions, {
				...defaultButtonStyles,
				label: localize('automations.duplicate', 'Duplicate'),
				onClick: () => {
					const plan = this.automations.getAutomation(selected.id);
					if (plan) void this.perform('duplicate:' + plan.id, () => this.dialogs.showAutomationDialog({
						initialValues: {
							name: localize('automations.copyName', '{0} copy', plan.name), prompt: plan.prompt, target: plan.target, schedule: plan.schedule, enabled: false
						}
					}));
				},
			}));
			const pause = lifetime.add(new Button(actions, {
				...defaultButtonStyles,
				label: '',
				onClick: () => {
					const plan = this.automations.getAutomation(selected.id);
					if (plan) void this.perform(plan.id, () => this.automations.updateAutomation(plan.id, { enabled: !plan.enabled }));
				},
			}));
			this.details.append(h(document, 'p', { className: 'ash-automation-section-description' }, localize('automations.executionRules', 'Closing this window keeps enabled schedules on their host. The device must be awake and the host running. Missed recurring runs and overlapping runs are skipped; a missed one-time task runs after recovery.')));
			this.details.append(h(document, 'h3', {}, localize('automations.history', 'Run history')));
			const history = h(document, 'div', { className: 'ash-automation-detail-history' });
			const empty = h(document, 'p', {}, localize('automations.emptyHistory', 'No runs yet. Run an automation now or wait for its next scheduled time.'));
			this.details.append(history, empty);
			const links = new Map<string, Button>();
			lifetime.add(toDisposable(() => { for (const button of links.values()) button.dispose(); }));
			lifetime.add(autorun(reader => {
				const plan = this.automations.automations.read(reader).find(plan => plan.id === selected.id);
				this.pendingChanged.read(reader);
				const runs = this.automations.runs.read(reader).filter(run => run.automationId === selected.id);
				const providers = this.automations.availableProviders.read(reader);
				heading.textContent = plan?.name ?? localize('automations.deleted', 'Deleted automation');
				state.textContent = plan?.enabled ? localize('automations.enabled', 'Enabled') : localize('automations.paused', 'Paused');
				prompt.textContent = plan?.prompt ?? '';
				directory.textContent = plan?.target.directory ?? '';
				schedule.textContent = plan ? this.scheduleLabel(plan.schedule) : '';
				revision.textContent = plan ? String(plan.revision) : '';
				next.textContent = plan?.nextRunAt ? new Date(plan.nextRunAt).toLocaleString(getNLSLanguage()) : localize('automations.noScheduledRun', 'No scheduled run');
				const provider = providers.find(provider => provider.id === plan?.target.providerId);
				host.textContent = provider?.label ?? localize('automations.hostOffline', 'Host unavailable');
				edit.enabled = !plan?.kind && this.automations.canUpdateAutomation(selected.id) && !this.pending.has('edit:' + selected.id);
				run.enabled = this.automations.canRunAutomation(selected.id) && !this.pending.has(selected.id);
				duplicate.enabled = !plan?.kind && !!provider && !this.pending.has('duplicate:' + selected.id);
				pause.label = plan?.enabled ? localize('automations.pause', 'Pause') : localize('automations.enable', 'Enable');
				pause.enabled = this.automations.canUpdateAutomation(selected.id) && !this.pending.has(selected.id);
				notice.textContent = runs.some(run => !['completed', 'failed', 'stopped', 'skipped'].includes(run.status))
					? localize('automations.alreadyRunning', 'This automation has an unfinished run. Open its details to review it or stop it before starting another run.') : '';
				notice.hidden = !notice.textContent;
				empty.hidden = runs.length > 0;
				for (const [id, button] of links) if (!runs.some(run => run.id === id)) { button.dispose(); links.delete(id); }
				for (const item of runs) {
					let button = links.get(item.id);
					if (!button) {
						button = new Button(history, {
							...defaultButtonStyles,
							label: '',
							onClick: () => this.openDetails({ kind: 'run', id: item.id, planId: selected.id }),
						});
						links.set(item.id, button);
					}
					button.label = localize('automations.runLink', '{0} · {1} · Version {2}', new Date(item.scheduledAt).toLocaleString(getNLSLanguage()), automationRunStatusLabel(item.status), item.revision);
				}
				this.orderRows(history, runs.map(run => links.get(run.id)!.domNode));
			}));
		} else {
			const scheduled = fact(localize('automations.scheduledTime', 'Scheduled time'));
			const started = fact(localize('automations.startedTime', 'Started'));
			const finished = fact(localize('automations.finishedTime', 'Finished'));
			const output = h(document, 'pre', { className: 'ash-automation-result', properties: { tabIndex: 0 } });
			const files = h(document, 'ul', { className: 'ash-automation-result-files' });
			const resultState = h(document, 'p', { attributes: { role: 'status' } });
			this.details.append(h(document, 'h3', {}, localize('automations.result', 'Result')), resultState, output,
				h(document, 'h3', {}, localize('automations.changedFiles', 'Changed files')), files);
			let resultKey = '';
			let generation = 0;
			lifetime.add(toDisposable(() => { generation++; }));
			const load = async (run: IAutomationRun): Promise<void> => {
				const current = ++generation;
				resultState.textContent = localize('automations.loadingResult', 'Loading result…');
				resultState.hidden = false;
				output.textContent = '';
				files.replaceChildren();
				try {
					const result = await this.automations.readRunResult(run);
					if (current !== generation) return;
					output.textContent = result.output;
					resultState.textContent = result.output ? '' : localize('automations.noResult', 'No final response has been recorded for this run.');
					resultState.hidden = !!result.output;
					if (result.files === undefined) files.append(h(document, 'li', {}, localize('automations.filesUnavailable', 'File changes could not be loaded. Refresh the result to try again.')));
					else if (!result.files.length) files.append(h(document, 'li', {}, localize('automations.noFiles', 'No recorded file changes.')));
					else for (const file of result.files) files.append(h(document, 'li', {}, localize('automations.fileSummary', '{0} · +{1} −{2}', file.path, file.additions, file.deletions)));
				} catch (error) {
					if (current === generation) resultState.textContent = localize('automations.resultFailed', 'Could not load the result: {0}', error instanceof Error ? error.message : String(error));
				}
			};
			const refresh = lifetime.add(new Button(actions, {
				...defaultButtonStyles,
				label: localize('automations.refreshResult', 'Refresh result'),
				onClick: () => { const run = this.automations.runs.get().find(run => run.id === selected.id); if (run) void load(run); },
			}));
			const open = lifetime.add(new Button(actions, {
				...defaultButtonStyles,
				label: localize('automations.openConversation', 'Open conversation'),
				onClick: () => {
					const run = this.automations.runs.get().find(run => run.id === selected.id);
					if (run?.sessionId && run.threadId) void this.perform(run.id, () => this.navigation.openConversation(run.sessionId!, run.threadId!, run.providerId));
				},
			}));
			const stop = lifetime.add(new Button(actions, {
				...defaultButtonStyles,
				label: localize('automations.stopRun', 'Stop run'),
				onClick: () => { const run = this.automations.runs.get().find(run => run.id === selected.id); if (run) void this.perform(run.id, () => this.automations.stopRun(run)); },
			}));
			const retry = lifetime.add(new Button(actions, {
				...defaultButtonStyles,
				label: localize('automations.runCurrentVersion', 'Run current version'),
				onClick: () => {
					const run = this.automations.runs.get().find(run => run.id === selected.id);
					const plan = run && this.automations.getAutomation(run.automationId);
					if (plan) void this.perform(plan.id, () => this.runner.runOnce(plan).whenDispatched);
				},
			}));
			lifetime.add(autorun(reader => {
				const run = this.automations.runs.read(reader).find(run => run.id === selected.id);
				this.automations.availableProviders.read(reader);
				this.automations.automations.read(reader);
				this.pendingChanged.read(reader);
				heading.textContent = run?.definition.name ?? localize('automations.runUnavailable', 'Run unavailable');
				state.textContent = run ? automationRunStatusLabel(run.status) : '';
				prompt.textContent = run?.definition.prompt ?? '';
				directory.textContent = run?.definition.target.directory ?? '';
				schedule.textContent = run ? this.scheduleLabel(run.definition.schedule) : '';
				revision.textContent = run ? String(run.revision) : '';
				const time = (value: number | null | undefined) => value == null ? '—' : new Date(value).toLocaleString(getNLSLanguage());
				scheduled.textContent = time(run?.scheduledAt);
				started.textContent = time(run?.startedAt);
				finished.textContent = time(run?.finishedAt);
				notice.textContent = run?.message ?? (run?.status === 'needsInput' ? localize('automations.inputNeeded', 'This run is waiting for your input. Open its conversation to review the request and respond.') : '');
				notice.hidden = !notice.textContent;
				open.hidden = !run?.sessionId || !run.threadId;
				stop.hidden = !run || !this.automations.canStopRun(run);
				stop.enabled = open.enabled = !this.pending.has(selected.id);
				retry.hidden = !run || !['completed', 'failed', 'stopped', 'skipped'].includes(run.status);
				retry.enabled = !!run && this.automations.canRunAutomation(run.automationId) && !this.pending.has(run.automationId);
				refresh.enabled = !!run && this.automations.canCreateAutomation(run.providerId);
				const key = run ? `${run.id}:${run.status}:${run.turnId}:${run.finishedAt}` : '';
				if (run && key !== resultKey) { resultKey = key; void load(run); }
				else if (!run) {
					generation++;
					resultKey = '';
					output.textContent = resultState.textContent = '';
					files.replaceChildren();
				}
			}));
		}
	}

	private scheduleLabel(schedule: IAutomationSchedule): string {
		switch (schedule.type) {
			case 'once': return localize('automations.scheduleOnce', 'Once · {0}', new Date(schedule.at).toLocaleString(getNLSLanguage()));
			case 'interval': return localize('automations.scheduleInterval', 'Every {0} minutes', schedule.minutes);
			case 'weekly': {
				const days = [localize('automations.mon', 'Mon'), localize('automations.tue', 'Tue'), localize('automations.wed', 'Wed'), localize('automations.thu', 'Thu'), localize('automations.fri', 'Fri'), localize('automations.sat', 'Sat'), localize('automations.sun', 'Sun')];
				const dayLabel = schedule.weekdays.length === 7 ? localize('automations.everyDay', 'Every day')
					: schedule.weekdays.length === 5 && [1, 2, 3, 4, 5].every(day => schedule.weekdays.includes(day)) ? localize('automations.weekdays', 'Weekdays')
						: schedule.weekdays.map(day => days[day - 1]).join(', ');
				return localize('automations.scheduleWeekly', '{0} · {1}:{2} ({3})', dayLabel, String(schedule.hour).padStart(2, '0'), String(schedule.minute).padStart(2, '0'), schedule.timezone);
			}
		}
	}

	private orderRows(parent: HTMLElement, rows: readonly HTMLElement[]): void {
		const focused = getActiveElement(parent.ownerDocument);
		const retainFocus = isHTMLElement(focused) && parent.contains(focused);
		for (const [index, row] of rows.entries()) {
			if (parent.children[index] !== row) parent.insertBefore(row, parent.children[index] ?? null);
		}
		if (retainFocus && getActiveElement(parent.ownerDocument) !== focused) focused.focus({ preventScroll: true });
	}

	private async perform(id: string, operation: () => Promise<unknown>): Promise<void> {
		if (this.pending.has(id)) return;
		const document = this.element.ownerDocument;
		const focused = getActiveElement(document);
		const restoreFocus = isHTMLElement(focused) && this.element.contains(focused);
		this.pending.add(id);
		this.pendingChanged.set(this.pendingChanged.get() + 1, undefined);
		this.updatePlans(this.automations.automations.get());
		this.updateRuns(this.automations.runs.get());
		try { await operation(); }
		catch (error) { if (!this.isDisposed) this.notifications.error(String(error)); }
		finally {
			this.pending.delete(id);
			this.pendingChanged.set(this.pendingChanged.get() + 1, undefined);
			if (!this.isDisposed) {
				this.updatePlans(this.automations.automations.get());
				this.updateRuns(this.automations.runs.get());
				// Disabling an in-flight action can blur its button. Restore only if the user has not moved elsewhere.
				if (restoreFocus && getActiveElement(document) === document.body) {
					if (focused.isConnected) focused.focus({ preventScroll: true });
					if (getActiveElement(document) === document.body) this.focus();
				}
			}
		}
	}
}

export class AutomationsCustomView extends AbstractCustomView {
	readonly title = constObservable(localize('automations.title', 'Automations'));
	override readonly description = constObservable(localize('automations.pageDescription', 'Let your agent handle recurring work. Manage schedules and pick up the results here.'));
	private widget: AutomationsCardsWidget | undefined;

	constructor(@IInstantiationService private readonly instantiation: IInstantiationService) { super(); }

	render(container: HTMLElement): void {
		this.widget = this._register(this.instantiation.createInstance(AutomationsCardsWidget, container));
		container.append(this.widget.element);
	}

	layout(_width: number, _height: number): void { }

	override focus(): void { this.widget?.focus(); }
}


export class AutomationsCustomViewContribution extends Disposable {
	static readonly ID = 'sessions.contrib.automationsCustomView';

	constructor(
		@ICustomViewService views: ICustomViewService,
		@ISessionsProvidersService providers: ISessionsProvidersService,
		@IAutomationService automations: IAutomationService,
		@IContextKeyService contexts: IContextKeyService,
		@IConfigurationService configuration: IConfigurationService,
		@INotificationService notifications: INotificationService,
		@ICommandService commands: ICommandService,
	) {
		super();
		const registrations = this._register(new MutableDisposable<DisposableStore>());
		const changed = observableSignalFromEvent(this, providers.onDidChangeProviders);
		const available = contexts.createKey<boolean>('sessions.automationsAvailable', false);
		const canCreate = contexts.createKey<boolean>('sessions.automationsCanCreate', false);
		const selected = contexts.createKey<boolean>('sessions.activity.automationsSelected', false);
		this._register(toDisposable(() => {
			available.reset();
			canCreate.reset();
			selected.reset();
		}));
		this._register(autorun(reader => {
			canCreate.set(automations.availableProviders.read(reader).length > 0);
			selected.set(views.activeCustomView.read(reader)?.id === AUTOMATIONS_CUSTOM_VIEW_ID);
		}));
		const previous = new Map<string, IAutomationRun['status']>();
		const knownProviders = new Set<string>();
		const notices = new Map<string, INotificationHandle>();
		this._register(toDisposable(() => { for (const notice of notices.values()) notice.close(); }));
		this._register(autorun(reader => {
			const runs = automations.runs.read(reader);
			changed.read(reader);
			// A disconnected host must not suppress notifications from another healthy host.
			const ready = new Set(providers.getProviders().filter(provider => provider.automations
				&& provider.automations.catalogueState.read(reader) === 'ready'
				&& (provider.automations.historyState?.read(reader) ?? 'ready') === 'ready').map(provider => provider.id));
			for (const [id, notice] of notices) {
				if (!runs.some(run => run.id === id)) { notice.close(); notices.delete(id); }
			}
			for (const id of previous.keys()) if (!runs.some(run => run.id === id)) previous.delete(id);
			for (const run of runs) {
				if (!ready.has(run.providerId) || previous.get(run.id) === run.status) continue;
				previous.set(run.id, run.status);
				notices.get(run.id)?.close();
				notices.delete(run.id);
				// The first history snapshot stays in the page; later status changes produce a toast once.
				if (!knownProviders.has(run.providerId)) continue;
				const severity = run.status === 'failed' ? Severity.Error
					: run.status === 'needsInput' ? Severity.Warning
						: run.status === 'completed' && configuration.getValue<boolean>('sessions.automations.notifyOnSuccess') === true ? Severity.Info : undefined;
				if (severity === undefined) continue;
				const message = localize('automations.runFailed', 'Automation {0}: {1}', run.definition.name, run.message ?? automationRunStatusLabel(run.status));
				const notice = notifications.notify({
					severity, message, actions: {
						primary: [{
							tooltip: '',
							enabled: true,
							id: 'sessions.automations.viewResult', label: localize('automations.viewResult', 'View result'),
							run: async () => {
								views.showCustomView(AUTOMATIONS_CUSTOM_VIEW_ID);
								await commands.executeCommand('sessions.automations.openRun', run.id);
							}
						}]
					}
				});
				notices.set(run.id, notice);
			}
			for (const provider of ready) knownProviders.add(provider);
		}));
		this._register(autorun(reader => {
			changed.read(reader);
			const supported = providers.getProviders().some(provider => provider.automations !== undefined);
			available.set(supported);
			if (!supported) {
				registrations.clear();
				return;
			}
			if (registrations.value) return;
			const lifetime = new DisposableStore();
			registrations.value = lifetime;
			lifetime.add(views.registerCustomView({
				id: AUTOMATIONS_CUSTOM_VIEW_ID,
				entryCommand: 'sessions.open.code',
				ctor: new SyncDescriptor(AutomationsCustomView),
				actions: { menuId: Menus.CustomViewAutomations, primaryActionId: 'sessionsView.newAutomation' }
			}));
			lifetime.add(registerAutomationsAccessibility());
			lifetime.add(registerAction2(class NewAutomation extends Action2 {
				constructor() {
					super({
						id: 'sessionsView.newAutomation',
						title: localize2('automations.new', 'New automation'),
						icon: Lxicon.add,
						precondition: ContextKeyExpr.has('sessions.automationsCanCreate'),
						menu: { id: Menus.CustomViewAutomations, group: 'navigation', order: 1 }
					});
				}
				override async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(IAutomationDialogService).showAutomationDialog({}); }
			}));
			lifetime.add(registerAction2(class RefreshAutomations extends Action2 {
				constructor() {
					super({
						id: 'sessions.automations.refresh',
						title: localize2('automations.refresh', 'Refresh'),
						icon: Lxicon.refresh,
						menu: { id: Menus.CustomViewAutomations, group: 'navigation', order: 2 }
					});
				}
				override async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(IAutomationService).refresh(); }
			}));
		}));
	}
}
