import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { Automation, AutomationDefinition, AutomationRun, AutomationSchedule, IAutomationService } from '../../../../platform/automation/common/automationService.js';
import type { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { getRemoteWorkspacePath, isRemoteResource } from '../../../../platform/remote/common/remote.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import type { ICommandService } from '../../../../platform/commands/common/commands.js';
import { OPEN_CHAT_COMMAND_ID } from '../../chat/common/chat.js';

export class AutomationViewPane extends ViewPane {
	private readonly status: HTMLDivElement;
	private readonly list: HTMLDivElement;
	private readonly history: HTMLDivElement;
	private readonly form: HTMLFormElement;
	private readonly title: HTMLInputElement;
	private readonly prompt: HTMLTextAreaElement;
	private readonly directory: HTMLInputElement;
	private readonly session: HTMLSelectElement;
	private readonly schedule: HTMLSelectElement;
	private readonly once: HTMLInputElement;
	private readonly minutes: HTMLInputElement;
	private readonly time: HTMLInputElement;
	private readonly timezone: HTMLInputElement;
	private readonly weekdays: readonly HTMLInputElement[];
	private readonly scheduleFields = new Map<string, HTMLElement>();
	private plans: readonly Automation[] = [];
	private runs: readonly AutomationRun[] = [];
	private selected: Automation | undefined;
	private refreshing = false;
	private refreshAgain = false;
	private working = false;

	constructor(container: HTMLElement, options: IViewPaneOptions, private readonly automation: IAutomationService, private readonly workspace: IWorkspaceContextService, private readonly sessions: IChatSessionNavigationService, private readonly commands: ICommandService) {
		super(container, options);
		const document = container.ownerDocument;
		this.contentElement.classList.add('ash-automation');
		this.status = h(document, 'div');
		this.status.setAttribute('role', 'status');
		const toolbar = h(document, 'div');
		toolbar.className = 'automation-actions';
		toolbar.append(this.button('New automation', 'new'), this.button('Refresh', 'refresh'));
		this.list = h(document, 'div');
		this.list.className = 'automation-list';
		this.list.setAttribute('aria-label', 'Automations');
		this.form = h(document, 'form');
		this.form.className = 'automation-form';
		this.title = this.input(this.form, 'Name');
		this.title.maxLength = 200;
		this.prompt = h(document, 'textarea');
		this.prompt.rows = 4;
		this.prompt.required = true;
		this.prompt.maxLength = 100_000;
		this.field(this.form, 'Instructions', this.prompt);
		this.directory = this.input(this.form, 'Directory');
		this.session = this.select(this.form, 'Conversation', [['new', 'New conversation for each run']]);
		this.schedule = this.select(this.form, 'Schedule', [['interval', 'Every N minutes'], ['weekly', 'Days of the week'], ['once', 'Once']]);
		const interval = this.scheduleSection('interval');
		this.minutes = this.input(interval, 'Interval in minutes', 'number');
		this.minutes.min = '1';
		this.minutes.max = '525600';
		this.minutes.value = '60';
		const once = this.scheduleSection('once');
		this.once = this.input(once, `Date and time (${Intl.DateTimeFormat().resolvedOptions().timeZone})`, 'datetime-local');
		const weekly = this.scheduleSection('weekly');
		this.time = this.input(weekly, 'Time', 'time');
		this.time.value = '09:00';
		this.timezone = this.input(weekly, 'Time zone');
		this.timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const days = h(document, 'fieldset');
		const legend = h(document, 'legend');
		legend.textContent = 'Run on';
		days.append(legend);
		this.weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, index) => {
			const input = this.input(days, day, 'checkbox');
			input.value = String(index + 1);
			input.checked = index < 5;
			input.required = false;
			return input;
		});
		weekly.append(days);
		const save = this.button('Save automation', 'save');
		save.type = 'submit';
		this.form.append(save);
		this.history = h(document, 'div');
		this.history.className = 'automation-history';
		this.history.setAttribute('aria-label', 'Run history');
		this.contentElement.append(toolbar, this.status, this.list, this.form, this.history);
		this._register(addDisposableListener(this.contentElement, 'click', event => this.activate(event)));
		this._register(addDisposableListener(this.schedule, 'change', () => this.updateScheduleFields()));
		this._register(addDisposableListener(this.form, 'submit', event => { event.preventDefault(); void this.perform(() => this.save()); }));
		this._register(automation.onDidChange(() => { void this.refresh(); }));
		this.newPlan();
		void this.refresh();
	}

	public override setVisible(visible: boolean): void { super.setVisible(visible); if (visible) { void this.refresh(); } }
	public override focus(): void { this.title.focus(); void this.refresh(); }

	private scheduleSection(type: string): HTMLElement {
		const section = h(this.element.ownerDocument, 'div');
		this.scheduleFields.set(type, section);
		this.form.append(section);
		return section;
	}

	private updateScheduleFields(): void {
		for (const [type, section] of this.scheduleFields) {
			section.hidden = this.schedule.value !== type;
			for (const input of section.querySelectorAll('input')) { input.disabled = section.hidden; }
		}
	}

	private field(parent: HTMLElement, text: string, control: HTMLElement): void {
		const label = h(this.element.ownerDocument, 'label');
		const caption = h(this.element.ownerDocument, 'span');
		caption.textContent = text;
		caption.id = `automation-field-${generateUuid()}`;
		control.setAttribute('aria-labelledby', caption.id);
		label.append(caption, control);
		parent.append(label);
	}

	private input(parent: HTMLElement, label: string, type = 'text'): HTMLInputElement {
		const input = h(this.element.ownerDocument, 'input');
		input.type = type;
		input.required = type !== 'checkbox';
		this.field(parent, label, input);
		return input;
	}

	private select(parent: HTMLElement, label: string, values: readonly (readonly [string, string])[]): HTMLSelectElement {
		const select = h(this.element.ownerDocument, 'select');
		for (const [value, text] of values) { select.add(new Option(text, value)); }
		this.field(parent, label, select);
		return select;
	}

	private button(label: string, action: string, id?: string): HTMLButtonElement {
		const button = h(this.element.ownerDocument, 'button');
		button.type = 'button';
		button.textContent = label;
		button.dataset.action = action;
		if (id) { button.dataset.id = id; }
		return button;
	}

	private newPlan(): void {
		this.selected = undefined;
		this.title.value = '';
		this.prompt.value = '';
		this.schedule.value = 'interval';
		this.minutes.value = '60';
		this.once.value = '';
		this.time.value = '09:00';
		this.timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
		for (const [index, day] of this.weekdays.entries()) { day.checked = index < 5; }
		const uri = this.workspace.getWorkspace().folders[0]?.uri;
		this.directory.value = uri ? (isRemoteResource(uri) ? getRemoteWorkspacePath(uri) : uri.fsPath) : '';
		this.session.replaceChildren(new Option('New conversation for each run', 'new'));
		for (const conversation of this.sessions.getConversations()) {
			this.session.add(new Option(conversation.title, JSON.stringify({ type: 'continue', sessionId: conversation.sessionId, threadId: conversation.threadId })));
		}
		this.history.replaceChildren();
		this.updateScheduleFields();
	}

	private async save(): Promise<void> {
		let schedule: AutomationSchedule;
		if (this.schedule.value === 'once') {
			const at = new Date(this.once.value).getTime();
			if (!Number.isFinite(at) || at <= Date.now()) { throw new Error('Choose a future date and time.'); }
			schedule = { type: 'once', at };
		} else if (this.schedule.value === 'weekly') {
			new Intl.DateTimeFormat('en', { timeZone: this.timezone.value });
			const [hour, minute] = this.time.value.split(':').map(Number);
			const weekdays = this.weekdays.filter(day => day.checked).map(day => Number(day.value));
			if (!weekdays.length) { throw new Error('Select at least one day.'); }
			schedule = { type: 'weekly', timezone: this.timezone.value, weekdays, hour: hour!, minute: minute! };
		} else {
			const minutes = Number(this.minutes.value);
			if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) { throw new Error('Choose an interval between 1 and 525600 minutes.'); }
			const previous = this.selected?.definition.schedule;
			schedule = { type: 'interval', minutes, anchor: previous?.type === 'interval' && previous.minutes === minutes ? previous.anchor : Date.now() + minutes * 60_000 };
		}
		const definition: AutomationDefinition = { title: this.title.value.trim(), prompt: this.prompt.value.trim(), directory: this.directory.value.trim(), session: this.session.value === 'new' ? { type: 'new' } : JSON.parse(this.session.value), schedule };
		this.selected = await this.automation.save(this.selected?.id ?? generateUuid(), this.selected?.revision ?? 0, definition, this.selected?.status ?? 'enabled');
		await this.refresh();
	}

	private activate(event: MouseEvent): void {
		const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
		if (!button || !this.contentElement.contains(button) || this.working) { return; }
		const action = button.dataset.action;
		const id = button.dataset.id;
		if (action === 'new') { this.newPlan(); this.title.focus(); return; }
		if (action === 'refresh') { void this.refresh(); return; }
		if (action === 'save') { return; }
		void this.perform(async () => {
			const plan = this.plans.find(plan => plan.id === id);
			if (action === 'edit' && plan) { this.edit(plan); }
			if (action === 'run' && plan) { await this.automation.run(plan.id); this.selected = plan; }
			if (action === 'pause' && plan) { const saved = await this.automation.save(plan.id, plan.revision, plan.definition, plan.status === 'enabled' ? 'paused' : 'enabled'); if (this.selected?.id === saved.id) { this.selected = saved; } }
			if (action === 'delete' && plan) { await this.automation.delete(plan.id, plan.revision); if (this.selected?.id === plan.id) { this.newPlan(); } }
			if (action === 'stop' && id) { await this.automation.stop(id); }
			if (action === 'open') {
				const run = this.runs.find(run => run.id === id);
				if (run?.sessionId && run.threadId) { await this.sessions.openConversation(run.sessionId, run.threadId); await this.commands.executeCommand(OPEN_CHAT_COMMAND_ID); }
			}
			await this.refresh();
		});
	}

	private edit(plan: Automation): void {
		this.newPlan();
		this.selected = plan;
		const definition = plan.definition;
		this.title.value = definition.title;
		this.prompt.value = definition.prompt;
		this.directory.value = definition.directory;
		if (definition.session.type === 'continue') {
			const value = JSON.stringify(definition.session);
			if (![...this.session.options].some(option => option.value === value)) { this.session.add(new Option('Saved conversation', value)); }
			this.session.value = value;
		}
		const schedule = definition.schedule;
		this.schedule.value = schedule.type;
		if (schedule.type === 'interval') { this.minutes.value = String(schedule.minutes); }
		if (schedule.type === 'once') { const date = new Date(schedule.at); this.once.value = new Date(schedule.at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
		if (schedule.type === 'weekly') {
			this.time.value = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
			this.timezone.value = schedule.timezone;
			for (const day of this.weekdays) { day.checked = schedule.weekdays.includes(Number(day.value)); }
		}
		this.updateScheduleFields();
	}

	private async perform(operation: () => Promise<void>): Promise<void> {
		if (this.working) { return; }
		this.working = true;
		this.form.setAttribute('aria-busy', 'true');
		try { await operation(); }
		catch (error) { if (!this.isDisposed) { this.status.textContent = error instanceof Error ? error.message : 'Automation operation failed.'; } }
		finally { this.working = false; this.form.removeAttribute('aria-busy'); }
	}

	private async refresh(): Promise<void> {
		if (this.refreshing) { this.refreshAgain = true; return; }
		this.refreshing = true;
		try {
			do {
				this.refreshAgain = false;
				const plans = await this.automation.list();
				const selected = this.selected?.id;
				const runs = selected ? await this.automation.runs(selected) : [];
				if (this.isDisposed) { return; }
				if (selected !== this.selected?.id) { this.refreshAgain = true; continue; }
				this.plans = plans;
				this.runs = runs;
				this.render();
			} while (this.refreshAgain);
		} catch (error) { if (!this.isDisposed) { this.status.textContent = error instanceof Error ? error.message : 'Could not load automations.'; } }
		finally { this.refreshing = false; }
	}

	private render(): void {
		const focused = this.element.ownerDocument.activeElement;
		const focus = focused instanceof HTMLButtonElement && (this.list.contains(focused) || this.history.contains(focused)) ? { action: focused.dataset.action, id: focused.dataset.id } : undefined;
		this.status.textContent = this.plans.length ? `${this.plans.length} automations. Select one to edit or view its runs.` : 'Schedule instructions for the agent. The backend keeps enabled schedules running after this window closes.';
		this.list.replaceChildren(...this.plans.map(plan => {
			const row = h(this.element.ownerDocument, 'div');
			row.className = 'automation-row';
			const label = this.button(plan.definition.title, 'edit', plan.id);
			label.setAttribute('aria-pressed', String(this.selected?.id === plan.id));
			label.classList.toggle('selected', this.selected?.id === plan.id);
			const detail = h(this.element.ownerDocument, 'span');
			detail.textContent = `${plan.status === 'paused' ? 'Paused' : 'Enabled'} · ${plan.nextRunAt === null ? 'No scheduled run' : `Next ${new Date(plan.nextRunAt).toLocaleString()}`}`;
			row.append(label, detail, this.button('Run now', 'run', plan.id), this.button(plan.status === 'enabled' ? 'Pause' : 'Enable', 'pause', plan.id), this.button('Delete', 'delete', plan.id));
			return row;
		}));
		this.history.replaceChildren(...this.runs.map(run => {
			const row = h(this.element.ownerDocument, 'div');
			row.className = 'automation-row';
			const label = h(this.element.ownerDocument, 'span');
			label.textContent = `${new Date(run.scheduledAt).toLocaleString()} · ${run.status}${run.message ? ` · ${run.message}` : ''}`;
			row.append(label);
			if (run.threadId) { row.append(this.button(run.status === 'needsInput' ? 'Continue in Chat' : 'Open conversation', 'open', run.id)); }
			if (['pending', 'running', 'needsInput'].includes(run.status)) { row.append(this.button('Stop run', 'stop', run.id)); }
			return row;
		}));
		if (focus) {
			const replacement = [...this.contentElement.querySelectorAll<HTMLButtonElement>('button[data-action]')].find(button => button.dataset.action === focus.action && button.dataset.id === focus.id);
			(replacement ?? this.title).focus();
		}
	}
}
