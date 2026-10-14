import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
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
	private readonly sections = new Map<string, HTMLElement>();
	private busy = false;
	private result: IAutomationDialogResult | undefined;

	constructor(parent: HTMLElement, private readonly options: IShowAutomationDialogOptions,
		providers: readonly IAutomationProviderDescriptor[], conversations: readonly { sessionId: string; threadId: string; title: string; }[],
		@IContextKeyService contexts: IContextKeyService,
	) {
		super();
		const document = parent.ownerDocument;
		const initial = options.existing ? {
			name: options.existing.name,
			prompt: options.existing.prompt,
			target: options.existing.target,
			schedule: options.existing.schedule,
			enabled: options.existing.enabled,
		} : options.initialValues;
		this.form = h(document, 'form', { className: 'ash-automation-form' });
		this.name = this.input(this.form, localize('automations.name', 'Name'));
		this.name.maxLength = 200;
		this.prompt = h(document, 'textarea');
		this.prompt.required = true;
		this.prompt.maxLength = 100_000;
		this.prompt.rows = 4;
		this.field(this.form, localize('automations.instructions', 'Instructions'), this.prompt);
		this.provider = this.select(this.form, localize('automations.provider', 'Run on'), providers.map(item => [item.id, item.label]));
		this.provider.disabled = !!options.existing;
		this.directory = this.input(this.form, localize('automations.directory', 'Directory'));
		this.conversation = this.select(this.form, localize('automations.conversation', 'Conversation'), [
			['new', localize('automations.newConversation', 'New conversation for each run')],
			...conversations.map(item => [JSON.stringify({ type: 'continue', sessionId: item.sessionId, threadId: item.threadId }), item.title] as const),
		]);
		this.schedule = this.select(this.form, localize('automations.schedule', 'Schedule'), [
			['interval', localize('automations.interval', 'Every N minutes')],
			['weekly', localize('automations.weekly', 'Days of the week')],
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
			localize('automations.mon', 'Mon'), localize('automations.tue', 'Tue'), localize('automations.wed', 'Wed'),
			localize('automations.thu', 'Thu'), localize('automations.fri', 'Fri'), localize('automations.sat', 'Sat'), localize('automations.sun', 'Sun'),
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
		if (initial?.target?.session.type === 'continue') {
			const value = JSON.stringify(initial.target.session);
			if (![...this.conversation.options].some(option => option.value === value)) this.conversation.append(this.option(localize('automations.savedConversation', 'Saved conversation'), value));
			this.conversation.value = value;
		}
		const schedule = initial?.schedule;
		this.schedule.value = schedule?.type ?? 'interval';
		if (schedule?.type === 'interval') this.minutes.value = String(schedule.minutes);
		if (schedule?.type === 'once') this.once.value = new Date(schedule.at - new Date(schedule.at).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
		if (schedule?.type === 'weekly') {
			this.timezone.value = schedule.timezone;
			this.time.value = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
			for (const day of this.weekdays) day.checked = schedule.weekdays.includes(Number(day.value));
		}
		this.message = h(document, 'p', { attributes: { role: 'status' } });
		this.form.append(this.message);
		this.save = this._register(new Button(this.form, { label: localize('automations.save', 'Save automation'), presentation: 'primary', type: 'submit' }));
		this.dialog = this._register(new Dialog(parent, {
			title: options.existing ? localize('automations.edit', 'Edit automation') : localize('automations.new', 'New automation'),
			content: this.form,
			buttons: [{ label: localize('automations.cancel', 'Cancel'), value: 'cancel' }],
			cancelValue: 'cancel',
		}));
		this.dialog.element.classList.add('ash-automation-dialog');
		this._register(contexts.createScoped(this.dialog.element)).createKey('sessionsAutomationDialogFocused', true);
		this._register(addDisposableListener(this.form, 'submit', event => {
			event.preventDefault();
			void this.commit();
		}));
		this._register(addDisposableListener(this.schedule, 'change', () => this.updateSections()));
		this._register(addDisposableListener(this.dialog.element, 'cancel', event => {
			if (this.busy) {
				event.preventDefault();
				event.stopImmediatePropagation();
			}
		}, true));
		this.updateSections();
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
		for (const button of this.dialog.element.querySelectorAll<HTMLButtonElement>('.ash-dialog-actions button')) button.disabled = true;
		try {
			const result = this.read();
			await this.options.commit?.(result);
			if (!this.isDisposed) {
				this.result = result;
				this.dialog.close('saved');
			}
		} catch (error) {
			if (!this.isDisposed) this.message.textContent = error instanceof Error ? error.message : localize('automations.operationFailed', 'Automation operation failed.');
		} finally {
			this.busy = false;
			if (!this.isDisposed) {
				this.save.enabled = true;
				this.form.removeAttribute('aria-busy');
				for (const button of this.dialog.element.querySelectorAll<HTMLButtonElement>('.ash-dialog-actions button')) button.disabled = false;
			}
		}
	}

	private read(): IAutomationDialogResult {
		let schedule: IAutomationSchedule;
		if (this.schedule.value === 'once') {
			const at = new Date(this.once.value).getTime();
			if (!Number.isFinite(at) || at <= Date.now()) throw new Error(localize('automations.futureDate', 'Choose a future date and time.'));
			schedule = { type: 'once', at };
		} else if (this.schedule.value === 'weekly') {
			try { new Intl.DateTimeFormat('en', { timeZone: this.timezone.value }); }
			catch { throw new Error(localize('automations.invalidTimezone', 'Choose a valid time zone.')); }
			const weekdays = this.weekdays.filter(day => day.checked).map(day => Number(day.value));
			if (!weekdays.length) throw new Error(localize('automations.chooseDay', 'Select at least one day.'));
			const [hour, minute] = this.time.value.split(':').map(Number);
			schedule = { type: 'weekly', timezone: this.timezone.value, weekdays, hour: hour!, minute: minute! };
		} else {
			const minutes = Number(this.minutes.value);
			if (!Number.isInteger(minutes) || minutes < 1 || minutes > 525600) throw new Error(localize('automations.chooseInterval', 'Choose an interval between 1 and 525600 minutes.'));
			const previous = this.options.existing?.schedule;
			schedule = {
				type: 'interval',
				minutes,
				anchor: previous?.type === 'interval' && previous.minutes === minutes ? previous.anchor : Date.now() + minutes * 60_000
			};
		}
		const value = {
			name: this.name.value.trim(),
			prompt: this.prompt.value.trim(),
			enabled: this.enabled.checked,
			schedule,
			target: {
				providerId: this.provider.value,
				directory: this.directory.value.trim(),
				session: this.conversation.value === 'new' ? { type: 'new' as const } : JSON.parse(this.conversation.value)
			}
		};
		return this.options.existing ? { kind: 'update', id: this.options.existing.id, value } : { kind: 'create', value };
	}

	private updateSections(): void {
		for (const [type, section] of this.sections) {
			section.hidden = this.schedule.value !== type;
			for (const input of section.querySelectorAll('input')) input.disabled = section.hidden;
		}
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
