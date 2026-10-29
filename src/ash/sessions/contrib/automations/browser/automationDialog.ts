import { defaultButtonStyles, defaultDialogStyles, defaultCheckboxStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import { IAutomationService } from '../../../../workbench/contrib/chat/common/automations/automationService.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import type { IAutomationSchedule } from '../../../../workbench/contrib/chat/common/automations/automation.js';
import type { IAutomationProviderDescriptor } from '../../../../workbench/contrib/chat/common/automations/automationService.js';
import type { IAutomationDialogResult, IShowAutomationDialogOptions } from '../../../../workbench/contrib/chat/common/automations/automationDialogService.js';
import './media/automationDialog.css';

/** One editing transaction. A rejected commit leaves the user's form and captured revision intact. */
export class AutomationDialog extends Disposable {
	private readonly form: HTMLFormElement;
	private readonly dialog: Dialog;
	private readonly name: HTMLInputElement;
	private readonly prompt: HTMLTextAreaElement;
	private readonly directory: HTMLInputElement;
	private readonly provider: HTMLSelectElement;
	private readonly conversation: HTMLSelectElement;
	private readonly schedule: HTMLSelectElement;
	private readonly minutes: HTMLInputElement;
	private readonly once: HTMLInputElement;
	private readonly time: HTMLInputElement;
	private readonly timezone: HTMLInputElement;
	private readonly weekdays: HTMLInputElement[];
	private readonly enabled: HTMLInputElement;
	private readonly message: HTMLElement;
	private readonly save: Button;
	private readonly cancel: Button;
	private readonly preview: HTMLElement;
	private readonly previewMessage: HTMLElement;
	private readonly previewHeading: HTMLElement;
	private previewGeneration = 0;
	private readonly sections = new Map<string, HTMLElement>();
	private busy = false;
	private result: IAutomationDialogResult | undefined;

	constructor(
		parent: HTMLElement,
		private readonly options: IShowAutomationDialogOptions,
		providers: readonly IAutomationProviderDescriptor[],
		conversations: readonly { providerId?: string; sessionId: string; threadId: string; title: string }[],
		@IContextKeyService contexts: IContextKeyService,
		@IAutomationService private readonly automations: IAutomationService,
	) {
		super();
		const document = parent.ownerDocument;
		const initial = options.existing
			? {
					name: options.existing.name,
					prompt: options.existing.prompt,
					target: options.existing.target,
					schedule: options.existing.schedule,
					enabled: options.existing.enabled,
				}
			: options.initialValues;
		this.form = h(document, 'form', { className: 'ash-automation-form' });
		this.form.id = generateUuid();
		this.form.append(h(document, 'h3', {}, localize('automations.taskSection', 'What to do')));
		this.name = this.input(this.form, localize('automations.name', 'Name'));
		this.name.maxLength = 200;
		this.prompt = h(document, 'textarea');
		this.prompt.required = true;
		this.prompt.maxLength = 100_000;
		this.prompt.rows = 4;
		this.field(this.form, localize('automations.instructions', 'Instructions'), this.prompt);
		this.form.append(h(document, 'h3', {}, localize('automations.environmentSection', 'Where to run')));
		this.provider = this.select(
			this.form,
			localize('automations.provider', 'Run on'),
			providers.map(item => [item.id, item.label]),
		);
		this.provider.disabled = !!options.existing;
		this.directory = this.input(this.form, localize('automations.directory', 'Directory'));
		const advanced = h(document, 'details');
		advanced.append(h(document, 'summary', {}, localize('automations.conversation', 'Conversation')));
		this.form.append(advanced);
		this.conversation = this.select(advanced, localize('automations.conversation', 'Conversation'), [['new', localize('automations.newConversation', 'New conversation for each run')]]);
		this.form.append(h(document, 'h3', {}, localize('automations.timingSection', 'When to run')));
		this.schedule = this.select(this.form, localize('automations.schedule', 'Schedule'), [
			['daily', localize('automations.everyDay', 'Every day')],
			['weekdays', localize('automations.weekdays', 'Weekdays')],
			['weekly', localize('automations.weekly', 'Days of the week')],
			['interval', localize('automations.interval', 'Every N minutes')],
			['once', localize('automations.once', 'Once')],
		]);
		const interval = this.section('interval');
		this.minutes = this.input(interval, localize('automations.intervalMinutes', 'Interval in minutes'), 'number');
		this.minutes.min = '1';
		this.minutes.max = '525600';
		this.minutes.value = '60';
		this.once = this.input(this.section('once'), localize('automations.dateTime', 'Date and time ({0})', Intl.DateTimeFormat().resolvedOptions().timeZone), 'datetime-local');
		const weekly = this.section('weekly');
		this.time = this.input(weekly, localize('automations.time', 'Time'), 'time');
		this.time.value = '09:00';
		this.timezone = this.input(weekly, localize('automations.timeZone', 'Time zone'));
		this.timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const days = h(document, 'fieldset');
		const legend = h(document, 'legend', {}, localize('automations.runOn', 'Run on'));
		days.append(legend);
		this.weekdays = [
			localize('automations.mon', 'Mon'),
			localize('automations.tue', 'Tue'),
			localize('automations.wed', 'Wed'),
			localize('automations.thu', 'Thu'),
			localize('automations.fri', 'Fri'),
			localize('automations.sat', 'Sat'),
			localize('automations.sun', 'Sun'),
		].map((day, index) => {
			const input = this.input(days, day, 'checkbox');
			input.value = String(index + 1);
			input.checked = index < 5;
			return input;
		});
		weekly.append(days);
		this.enabled = this.input(this.form, localize('automations.enabled', 'Enabled'), 'checkbox');
		this.enabled.checked = initial?.enabled !== false;
		this.name.value = initial?.name ?? '';
		this.prompt.value = initial?.prompt ?? '';
		this.directory.value = initial?.target?.directory ?? '';
		this.provider.value = initial?.target?.providerId ?? providers[0]?.id ?? '';
		const updateConversations = (): void => {
			this.conversation.replaceChildren(this.option(localize('automations.newConversation', 'New conversation for each run'), 'new'));
			for (const item of conversations) {
				// A destination without an owner must never be offered on a different host.
				if (item.providerId !== this.provider.value) {
					continue;
				}
				this.conversation.append(this.option(item.title, JSON.stringify({ type: 'continue', sessionId: item.sessionId, threadId: item.threadId })));
			}
		};
		updateConversations();
		this._register(
			addDisposableListener(this.provider, 'change', () => {
				// Changing hosts must not retain a directory or raw Session identity selected on the previous host.
				this.directory.value = '';
				updateConversations();
			}),
		);
		if (initial?.target?.session.type === 'continue') {
			advanced.open = true;
			const value = JSON.stringify(initial.target.session);
			if (![...this.conversation.options].some(option => option.value === value)) this.conversation.append(this.option(localize('automations.savedConversation', 'Saved conversation'), value));
			this.conversation.value = value;
		}
		const schedule = initial?.schedule;
		this.schedule.value = schedule?.type ?? 'daily';
		if (schedule?.type === 'interval') this.minutes.value = String(schedule.minutes);
		if (schedule?.type === 'once') this.once.value = new Date(schedule.at - new Date(schedule.at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
		if (schedule?.type === 'weekly') {
			this.schedule.value = schedule.weekdays.length === 7 ? 'daily' : schedule.weekdays.length === 5 && [1, 2, 3, 4, 5].every(day => schedule.weekdays.includes(day)) ? 'weekdays' : 'weekly';
			this.timezone.value = schedule.timezone;
			this.time.value = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
			for (const day of this.weekdays) day.checked = schedule.weekdays.includes(Number(day.value));
		}
		const preview = h(document, 'section', { className: 'ash-automation-schedule-preview' });
		this.previewHeading = h(document, 'h3');
		this.previewMessage = h(document, 'p', { attributes: { role: 'status' } });
		this.preview = h(document, 'ol');
		preview.append(this.previewHeading, this.previewMessage, this.preview);
		this.form.append(preview);
		this.message = h(document, 'p', {
			attributes: { role: 'status', 'aria-label': localize('automations.saveStatus', 'Save status') },
		});
		this.form.append(this.message);
		const actions = h(document, 'div', { className: 'ash-dialog-actions' });
		this.dialog = this._register(
			new Dialog(parent, options.existing ? localize('automations.edit', 'Edit automation') : localize('automations.new', 'New automation'), [], {
				buttonStyles: defaultButtonStyles,
				checkboxStyles: defaultCheckboxStyles,
				inputBoxStyles: defaultInputBoxStyles,
				dialogStyles: defaultDialogStyles,
				extraClasses: ['ash-automation-dialog'],
				disableCloseButton: true,
				disableDefaultAction: true,
				keyEventProcessor: event => {
					if (this.busy && event.key === 'Escape') event.stop({ preventDefault: true });
				},
				renderBody: body => body.append(this.form),
				renderFooter: footer => footer.append(actions),
			}),
		);
		// Commit stays a native form action, and the caller owns only its business controls.
		this.save = this._register(
			new Button(actions, {
				...defaultButtonStyles,
				label: localize('automations.save', 'Save automation'),
				presentation: 'primary',
				type: 'submit',
			}),
		);
		this.save.domNode.setAttribute('form', this.form.id);
		this.cancel = this._register(
			new Button(actions, {
				...defaultButtonStyles,
				label: localize('automations.cancel', 'Cancel'),
				presentation: 'secondary',
				onClick: () => this.dialog.dispose(),
			}),
		);
		for (const scope of [this.form, actions]) this._register(contexts.createScoped(scope)).createKey('sessionsAutomationDialogFocused', true);
		this._register(
			addDisposableListener(this.form, 'submit', event => {
				event.preventDefault();
				void this.commit();
			}),
		);
		const previewScheduler = this._register(
			new RunOnceScheduler(() => {
				void this.updatePreview();
			}, 200),
		);
		const changed = (): void => {
			this.previewGeneration++;
			this.preview.replaceChildren();
			this.previewMessage.textContent = localize('automations.previewLoading', 'Calculating upcoming runs…');
			this.updateSections();
			previewScheduler.schedule();
		};
		this._register(addDisposableListener(this.form, 'input', changed));
		this._register(addDisposableListener(this.form, 'change', changed));

		this.updateSections();
		void this.updatePreview();
	}

	async show(): Promise<IAutomationDialogResult | undefined> {
		await this.dialog.show();
		return this.result;
	}

	private async commit(): Promise<void> {
		if (this.busy || !this.form.reportValidity()) return;
		this.busy = true;
		this.save.enabled = false;
		this.form.setAttribute('aria-busy', 'true');
		this.cancel.enabled = false;
		try {
			const result = this.read();
			await this.options.commit?.(result);
			if (!this.isDisposed) {
				this.result = result;
				this.dialog.dispose();
			}
		} catch (error) {
			if (!this.isDisposed) this.message.textContent = error instanceof Error ? error.message : localize('automations.operationFailed', 'Automation operation failed.');
		} finally {
			this.busy = false;
			if (!this.isDisposed) {
				this.save.enabled = true;
				this.form.removeAttribute('aria-busy');
				this.cancel.enabled = true;
			}
		}
	}

	private readSchedule(): IAutomationSchedule {
		let schedule: IAutomationSchedule;
		if (this.schedule.value === 'once') {
			const at = new Date(this.once.value).getTime();
			if (!Number.isFinite(at) || at <= Date.now()) throw new Error(localize('automations.futureDate', 'Choose a future date and time.'));
			schedule = { type: 'once', at };
		} else if (['weekly', 'daily', 'weekdays'].includes(this.schedule.value)) {
			try {
				new Intl.DateTimeFormat('en', { timeZone: this.timezone.value });
			} catch {
				throw new Error(localize('automations.invalidTimezone', 'Choose a valid time zone.'));
			}
			const weekdays =
				this.schedule.value === 'daily' ? [1, 2, 3, 4, 5, 6, 7] : this.schedule.value === 'weekdays' ? [1, 2, 3, 4, 5] : this.weekdays.filter(day => day.checked).map(day => Number(day.value));
			if (!weekdays.length) throw new Error(localize('automations.chooseDay', 'Select at least one day.'));
			const [hour, minute] = this.time.value.split(':').map(Number);
			if (!this.time.value) throw new Error(localize('automations.chooseTime', 'Choose a time.'));
			schedule = { type: 'weekly', timezone: this.timezone.value, weekdays, hour: hour!, minute: minute! };
		} else {
			const minutes = Number(this.minutes.value);
			if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) throw new Error(localize('automations.chooseInterval', 'Choose an interval between 1 and 525600 minutes.'));
			const previous = this.options.existing?.schedule;
			schedule = {
				type: 'interval',
				minutes,
				anchor: previous?.type === 'interval' && previous.minutes === minutes ? previous.anchor : Date.now() + minutes * 60_000,
			};
		}
		return schedule;
	}

	private async updatePreview(): Promise<void> {
		const generation = ++this.previewGeneration;
		this.preview.replaceChildren();
		try {
			const schedule = this.readSchedule();
			const timezone = schedule.type === 'weekly' ? schedule.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
			this.previewHeading.textContent = localize('automations.upcomingRuns', 'Upcoming runs ({0})', timezone);
			this.previewMessage.textContent = localize('automations.previewLoading', 'Calculating upcoming runs…');
			const times = await this.automations.previewSchedule(this.provider.value, schedule);
			if (this.isDisposed || generation !== this.previewGeneration) return;
			this.previewMessage.textContent = times.length ? '' : localize('automations.previewEmpty', 'There are no future occurrences for this schedule.');
			for (const time of times) this.preview.append(h(this.form.ownerDocument, 'li', {}, new Date(time).toLocaleString(getNLSLanguage(), { timeZone: timezone })));
		} catch (error) {
			if (!this.isDisposed && generation === this.previewGeneration)
				this.previewMessage.textContent = error instanceof Error ? error.message : localize('automations.previewFailed', 'Could not preview this schedule.');
		}
	}

	private read(): IAutomationDialogResult {
		const value = {
			name: this.name.value.trim(),
			prompt: this.prompt.value.trim(),
			enabled: this.enabled.checked,
			schedule: this.readSchedule(),
			target: {
				providerId: this.provider.value,
				directory: this.directory.value.trim(),
				session: this.conversation.value === 'new' ? { type: 'new' as const } : JSON.parse(this.conversation.value),
			},
		};
		return this.options.existing ? { kind: 'update', id: this.options.existing.id, value } : { kind: 'create', value };
	}

	private updateSections(): void {
		const selected = ['daily', 'weekdays'].includes(this.schedule.value) ? 'weekly' : this.schedule.value;
		for (const [type, section] of this.sections) {
			section.hidden = selected !== type;
			for (const input of section.querySelectorAll('input')) input.disabled = section.hidden;
		}
		const days = this.weekdays[0]?.closest('fieldset');
		if (days) days.hidden = this.schedule.value !== 'weekly';
	}

	private section(type: string): HTMLElement {
		const node = h(this.form.ownerDocument, 'div');
		this.sections.set(type, node);
		this.form.append(node);
		return node;
	}

	private field(parent: HTMLElement, label: string, control: HTMLElement): void {
		const node = h(parent.ownerDocument, 'label');
		const caption = h(parent.ownerDocument, 'span', { attributes: { id: `automation-field-${generateUuid()}` } }, label);
		control.setAttribute('aria-labelledby', caption.id);
		node.append(caption, control);
		parent.append(node);
	}

	private input(parent: HTMLElement, label: string, type = 'text'): HTMLInputElement {
		const input = h(parent.ownerDocument, 'input');
		input.type = type;
		input.required = type !== 'checkbox';
		this.field(parent, label, input);
		return input;
	}

	private option(label: string, value: string): HTMLOptionElement {
		const option = h(this.form.ownerDocument, 'option');
		option.value = value;
		option.textContent = label;
		return option;
	}

	private select(parent: HTMLElement, label: string, choices: readonly (readonly [string, string])[]): HTMLSelectElement {
		const select = h(parent.ownerDocument, 'select');
		for (const [value, label] of choices) select.append(this.option(label, value));
		this.field(parent, label, select);
		return select;
	}
}
