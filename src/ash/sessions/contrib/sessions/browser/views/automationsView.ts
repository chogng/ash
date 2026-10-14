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
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, autorun, observableSignalFromEvent } from '../../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import type { IAutomationDescriptor, IAutomationRun } from '../../../../../workbench/contrib/chat/common/automations/automation.js';
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
	readonly detail: HTMLElement;
	readonly run: Button;
	readonly pause: Button;
	readonly remove: Button;
}

interface RunRow {
	readonly lifetime: DisposableStore;
	readonly element: HTMLElement;
	readonly text: HTMLElement;
	readonly open: Button;
	readonly stop: Button;
}

/** Keeps card identity and focus stable while provider-owned snapshots change. */
export class AutomationsCardsWidget extends Disposable {
	readonly element: HTMLElement;
	private readonly plans: HTMLElement;
	private readonly history: HTMLElement;
	private readonly message: HTMLElement;
	private readonly cards = new Map<string, PlanCard>();
	private readonly rows = new Map<string, RunRow>();
	private readonly pending = new Set<string>();

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
		this.message = h(document, 'p', { attributes: { role: 'status' } });
		this.plans = h(document, 'div', { className: 'ash-automation-cards' });
		const heading = h(document, 'h2', {}, localize('automations.history', 'Run history'));
		const historyMessage = h(document, 'p', { attributes: { role: 'status' } });
		this.history = h(document, 'div', { className: 'ash-automation-history' });
		this.element.append(this.message, this.plans, heading, historyMessage, this.history);
		this._register(addDisposableListener(this.element, 'focusin', event => {
			if (!this.element.contains(event.relatedTarget as Node) && configuration.getValue<boolean>(AccessibilityVerbositySettingId.Automations)) status(localize('automations.helpHint', 'Press Alt+F1 for Automations keyboard help.'));
		}));
		this._register(toDisposable(() => {
			for (const card of this.cards.values()) card.lifetime.dispose();
			for (const row of this.rows.values()) row.lifetime.dispose();
			this.element.remove();
		}));
		this._register(autorun(reader => {
			const plans = automations.automations.read(reader);
			const runs = automations.runs.read(reader);
			const state = automations.catalogueState.read(reader);
			const historyState = automations.historyState?.read(reader);
			historyMessage.textContent = historyState === 'error'
				? localize('automations.historyRefreshFailed', 'Run history could not be refreshed. Showing the last available history. Use Refresh to try again.') : '';
			historyMessage.hidden = !historyMessage.textContent;
			this.message.textContent = state === 'loading' ? localize('automations.loading', 'Loading automations…')
				: state === 'error' ? localize('automations.loadFailed', 'Could not load automations.')
					: state === 'unavailable' ? localize('automations.unavailable', 'The owning automation host is unavailable. Saved results may be out of date.')
						: plans.length ? localize('automations.cardHint', 'Select an automation to edit it. Runs continue on their host when this view closes.')
							: localize('automations.empty', 'Schedule instructions for the agent. The backend keeps enabled schedules running after this window closes.');
			this.element.setAttribute('aria-busy', String(state === 'loading'));
			this.updatePlans(plans);
			this.updateRuns(runs);
		}));
	}

	focus(): void {
		this.cards.values().next().value?.title.focus();
		if (!this.cards.size) this.element.focus();
	}

	private updatePlans(plans: readonly IAutomationDescriptor[]): void {
		for (const [id, card] of this.cards) if (!plans.some(plan => plan.id === id)) {
			card.lifetime.dispose();
			this.cards.delete(id);
		}
		for (const plan of plans) {
			let card = this.cards.get(plan.id);
			if (!card) {
				const lifetime = new DisposableStore();
				const element = h(this.element.ownerDocument, 'article', { className: 'ash-automation-card', attributes: { 'data-automation-id': plan.id, 'aria-label': plan.name } });
				const heading = h(this.element.ownerDocument, 'h3');
				element.append(heading);
				const title = lifetime.add(new Button(heading, {
					label: plan.name,
					presentation: 'quiet',
					onClick: () => {
						const current = this.automations.getAutomation(plan.id);
						if (current) void this.perform('edit:' + plan.id, () => this.dialogs.showAutomationDialog({ existing: current }));
					}
				}));
				const detail = h(this.element.ownerDocument, 'p');
				element.append(detail);
				const actions = h(this.element.ownerDocument, 'div', { className: 'ash-automation-card-actions' });
				element.append(actions);
				const run = lifetime.add(new Button(actions, {
					label: localize('automations.runNow', 'Run now'),
					onClick: () => {
						const current = this.automations.getAutomation(plan.id);
						if (current) void this.perform(plan.id, () => this.runner.runOnce(current).whenDispatched);
					}
				}));
				const pause = lifetime.add(new Button(actions, {
					label: '',
					onClick: () => {
						const current = this.automations.getAutomation(plan.id);
						if (current) void this.perform(plan.id, () => this.automations.updateAutomation(plan.id, { enabled: !current.enabled }));
					}
				}));
				const remove = lifetime.add(new Button(actions, {
					label: localize('automations.delete', 'Delete'),
					presentation: 'quiet',
					onClick: () => { void this.perform(plan.id, () => this.automations.deleteAutomation(plan.id)); }
				}));
				lifetime.add(toDisposable(() => element.remove()));
				this.plans.append(element);
				card = { lifetime, element, title, detail, run, pause, remove };
				this.cards.set(plan.id, card);
			}
			card.title.label = plan.name;
			card.element.setAttribute('aria-label', plan.name);
			card.detail.textContent = `${plan.enabled ? localize('automations.enabled', 'Enabled') : localize('automations.paused', 'Paused')} · ${plan.nextRunAt === null ? localize('automations.noScheduledRun', 'No scheduled run') : localize('automations.nextRun', 'Next {0}', new Date(plan.nextRunAt).toLocaleString())}`;
			card.pause.label = plan.enabled ? localize('automations.pause', 'Pause') : localize('automations.enable', 'Enable');
			const idle = !this.pending.has(plan.id);
			card.title.enabled = card.pause.enabled = idle && this.automations.canUpdateAutomation(plan.id);
			card.run.enabled = idle && this.automations.canRunAutomation(plan.id);
			card.remove.enabled = idle && this.automations.canDeleteAutomation(plan.id);
		}
		this.orderRows(this.plans, plans.map(plan => this.cards.get(plan.id)!.element));
	}

	private updateRuns(runs: readonly IAutomationRun[]): void {
		for (const [id, row] of this.rows) if (!runs.some(run => run.id === id)) {
			row.lifetime.dispose();
			this.rows.delete(id);
		}
		for (const run of runs) {
			let row = this.rows.get(run.id);
			if (!row) {
				const lifetime = new DisposableStore();
				const element = h(this.element.ownerDocument, 'div', { className: 'ash-automation-run', attributes: { 'data-run-id': run.id } });
				const text = h(this.element.ownerDocument, 'p');
				element.append(text);
				const actions = h(this.element.ownerDocument, 'div', { className: 'ash-automation-card-actions' });
				element.append(actions);
				const open = lifetime.add(new Button(actions, {
					label: localize('automations.openConversation', 'Open conversation'),
					onClick: () => {
						const current = this.automations.runs.get().find(item => item.id === run.id);
						if (current?.sessionId && current.threadId) void this.perform(run.id, () => this.navigation.openConversation(current.sessionId!, current.threadId!));
					}
				}));
				const stop = lifetime.add(new Button(actions, {
					label: localize('automations.stopRun', 'Stop run'),
					onClick: () => {
						const current = this.automations.runs.get().find(item => item.id === run.id);
						if (current) void this.perform(run.id, () => this.automations.stopRun(current));
					}
				}));
				lifetime.add(toDisposable(() => element.remove()));
				this.history.append(element);
				row = { lifetime, element, text, open, stop };
				this.rows.set(run.id, row);
			}
			row.text.textContent = `${this.automations.getAutomation(run.automationId)?.name ?? ''} · ${new Date(run.scheduledAt).toLocaleString()} · ${automationRunStatusLabel(run.status)}${run.message ? ` · ${run.message}` : ''}`;
			row.open.label = run.status === 'needsInput' ? localize('automations.continueChat', 'Continue in Chat') : localize('automations.openConversation', 'Open conversation');
			row.open.domNode.hidden = !run.sessionId || !run.threadId;
			row.stop.domNode.hidden = !this.automations.canStopRun(run);
			row.stop.enabled = row.open.enabled = !this.pending.has(run.id);
		}
		this.orderRows(this.history, runs.map(run => this.rows.get(run.id)!.element));
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
		this.pending.add(id);
		this.updatePlans(this.automations.automations.get());
		this.updateRuns(this.automations.runs.get());
		try { await operation(); }
		catch (error) { if (!this.isDisposed) this.notifications.error(String(error)); }
		finally {
			this.pending.delete(id);
			if (!this.isDisposed) {
				this.updatePlans(this.automations.automations.get());
				this.updateRuns(this.automations.runs.get());
			}
		}
	}
}

export class AutomationsCustomView extends AbstractCustomView {
	readonly title = constObservable(localize('automations.title', 'Automations'));
	override readonly description = constObservable(localize('automations.description', 'Schedule agent instructions and review their runs.'));
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
				ctor: new SyncDescriptor(AutomationsCustomView),
				actions: { menuId: Menus.CustomViewAutomations }
			}));
			lifetime.add(registerAutomationsAccessibility());
			lifetime.add(registerAction2(class NewAutomation extends Action2 {
				constructor() {
					super({
						id: 'sessionsView.newAutomation',
						title: localize2('automations.new', 'New automation'),
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
						menu: { id: Menus.CustomViewAutomations, group: 'navigation', order: 2 }
					});
				}
				override async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(IAutomationService).refresh(); }
			}));
		}));
	}
}
