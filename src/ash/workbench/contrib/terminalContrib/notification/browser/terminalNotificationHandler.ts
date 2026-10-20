import type { IAction } from '../../../../../base/common/actions.js';
import { decodeBase64 } from '../../../../../base/common/buffer.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { NotificationPriority, Severity, type INotification, type INotificationHandle } from '../../../../../platform/notification/common/notification.js';

/** Per-instance callbacks keep protocol replies and focus bound to the emitting process. */
export interface IOsc99NotificationHost {
	isEnabled(): boolean;
	isWindowFocused(): boolean;
	isTerminalVisible(): boolean;
	focusTerminal(): void;
	notify(notification: INotification): INotificationHandle;
	updateEnableNotifications(value: boolean): Promise<void>;
	logWarn(message: string): void;
	writeToProcess(data: string): void;
}

interface NotificationContent {
	title: string;
	body: string;
	buttons: string;
	focus: boolean;
	report: boolean;
	closeReport: boolean;
	urgency: number;
	wait: number;
	occasion: string;
}

interface NotificationEntry {
	readonly id: string;
	key: string;
	readonly lifetime: DisposableStore;
	pending?: NotificationContent;
	displayed?: NotificationContent;
	handle?: INotificationHandle;
	timer?: ReturnType<typeof setTimeout>;
	/** Only an ordinary user close is interpreted as body activation. */
	closeReason?: 'action' | 'dismiss' | 'process' | 'timer' | 'dispose';
}

const maxContentLength = 64 * 1024;
const maxEntries = 128;

/** OSC is untrusted process output. This owner bounds both incomplete messages and live handles. */
export class TerminalNotificationHandler extends Disposable {
	private readonly entries = new Map<string, NotificationEntry>();
	private anonymousId = 0;

	constructor(private readonly host: IOsc99NotificationHost) { super(); }

	handleSequence(data: string): boolean {
		if (this.isDisposed || !this.host.isEnabled()) return true;
		const separator = data.indexOf(';');
		if (separator < 0 || separator > 4096 || data.length > maxContentLength + 4096) {
			this.host.logWarn('Discarded an invalid or oversized OSC 99 sequence');
			return true;
		}
		const fields = new Map<string, string>();
		for (const field of data.slice(0, separator).split(':')) {
			const equal = field.indexOf('=');
			if (equal > 0) fields.set(field.slice(0, equal), field.slice(equal + 1));
		}
		const id = (fields.get('i') ?? '').replace(/[^a-zA-Z0-9_+.-]/g, '').slice(0, 256);
		const type = fields.get('p') || 'title';
		if (type === '?') {
			this.reply(`i=${id || '0'}:p=?:a=report,focus:c=1:o=always,unfocused,invisible:p=title,body,buttons,close,alive,?:u=0,1,2:w=1`);
			return true;
		}
		if (type === 'alive') {
			this.reply(`i=${id || '0'}:p=alive`, [...this.entries.values()].filter(entry => entry.id && entry.handle).map(entry => entry.id).join(','));
			return true;
		}
		if (type === 'close') {
			if (id) this.closeEntry(this.entries.get(id), 'process');
			return true;
		}
		if (type !== 'title' && type !== 'body' && type !== 'buttons') return true;
		let payload = data.slice(separator + 1);
		if (fields.get('e') === '1') {
			try {
				const unpadded = payload.replace(/=+$/, '');
				if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(payload) || unpadded.length % 4 === 1
					|| (unpadded.length !== payload.length && payload.length % 4 !== 0)) {
					throw new Error('Invalid base64 payload');
				}
				// The buffer decoder accepts URL-safe/unpadded base64; TextDecoder rejects
				// invalid UTF-8 instead of joining malformed fragments into later messages.
				payload = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(payload).buffer);
			} catch {
				this.host.logWarn('Discarded an invalid OSC 99 encoded payload');
				this.closeEntry(this.entries.get(id), 'process');
				return true;
			}
		}
		let entry = this.entries.get(id);
		if (!entry) {
			if (this.entries.size >= maxEntries) this.closeEntry(this.entries.values().next().value, 'dispose');
			entry = { id, key: id, lifetime: new DisposableStore() };
			this.entries.set(id, entry);
		}
		const pending = entry.pending ??= {
			title: '', body: '', buttons: '', focus: true, report: false, closeReport: false, urgency: 1, wait: 0, occasion: 'always',
		};
		if (pending.title.length + pending.body.length + pending.buttons.length + payload.length > maxContentLength) {
			this.host.logWarn('Discarded an oversized OSC 99 notification');
			this.closeEntry(entry, 'process');
			return true;
		}
		pending[type] += payload;
		for (const action of fields.get('a')?.split(',') ?? []) {
			if (action === 'focus' || action === '-focus') pending.focus = action === 'focus';
			if (action === 'report' || action === '-report') pending.report = action === 'report';
		}
		if (fields.has('c')) pending.closeReport = fields.get('c') === '1';
		if (/^[012]$/.test(fields.get('u') ?? '')) pending.urgency = Number(fields.get('u'));
		if (/^\d{1,10}$/.test(fields.get('w') ?? '')) pending.wait = Math.min(Number(fields.get('w')), 2147483647);
		if (['always', 'unfocused', 'invisible'].includes(fields.get('o') ?? '')) pending.occasion = fields.get('o')!;
		if (fields.get('d') === '0') return true;
		if ((pending.occasion === 'unfocused' && this.host.isWindowFocused())
			|| (pending.occasion === 'invisible' && (this.host.isWindowFocused() || this.host.isTerminalVisible()))) {
			entry.pending = undefined;
			if (!entry.handle) this.closeEntry(entry, 'dispose');
			return true;
		}
		const message = [plainText(pending.title), plainText(pending.body)].filter(text => text.trim()).join(': ');
		if (!message) return true;
		entry.pending = undefined;
		entry.displayed = pending;
		if (!id) {
			// Anonymous chunks share a draft, but completed anonymous notifications
			// have independent lifetimes and cannot replace one another.
			this.entries.delete('');
			entry.key = `#${++this.anonymousId}`;
			this.entries.set(entry.key, entry);
		}
		const actions = this.actions(entry, pending);
		const severity = pending.urgency === 2 ? Severity.Warning : Severity.Info;
		if (entry.timer) clearTimeout(entry.timer);
		if (entry.handle) {
			entry.handle.updateMessage(message);
			entry.handle.updateSeverity(severity);
			entry.handle.updateActions(actions);
		} else {
			entry.handle = this.host.notify({
				message, severity, actions,
				priority: pending.urgency === 0 ? NotificationPriority.SILENT : NotificationPriority.DEFAULT,
				source: { id: 'terminal', label: localize('terminal.notification.source', 'Terminal') },
			});
			const active = entry;
			const closeListener = entry.handle.onDidClose(() => {
				if (this.entries.get(active.key) !== active) return;
				const content = active.displayed!;
				if (!active.closeReason && content.report) this.activate(active);
				if (content.closeReport && active.closeReason !== 'dispose') this.reply(`i=${id || '0'}:p=close`);
				this.entries.delete(active.key);
				if (active.timer) clearTimeout(active.timer);
				active.lifetime.dispose();
			});
			// The notification owner can synchronously replay an earlier close while
			// subscribing. Its listener must then be released without re-adding it.
			if (entry.lifetime.isDisposed) closeListener.dispose();
			else entry.lifetime.add(closeListener);
		}
		if (pending.wait > 0 && this.entries.get(entry.key) === entry) {
			entry.timer = setTimeout(() => this.closeEntry(entry, 'timer'), pending.wait);
		}
		return true;
	}

	private actions(entry: NotificationEntry, content: NotificationContent): INotification['actions'] {
		const action = (id: string, label: string, run: () => unknown): IAction => ({ id, label, tooltip: label, enabled: true, run });
		return {
			primary: content.buttons.split('\u2028').slice(0, 32).map((label, index) => ({ label: plainText(label), index })).flatMap(({ label, index }) => label.trim() ? [
				action(`terminal.osc99.button.${index}`, label, () => {
					if (!this.isCurrent(entry, content)) return;
					this.activate(entry, index + 1);
					this.closeEntry(entry, 'action');
				}),
			] : []),
			secondary: [
				action('terminal.osc99.dismiss', localize('terminal.notification.dismiss', 'Dismiss'), () => {
					if (this.isCurrent(entry, content)) this.closeEntry(entry, 'dismiss');
				}),
				action('terminal.osc99.disable', localize('terminal.notification.disable', 'Disable Terminal Notifications'), async () => {
					if (!this.isCurrent(entry, content)) return;
					await this.host.updateEnableNotifications(false);
					this.clear();
				}),
			],
		};
	}

	private isCurrent(entry: NotificationEntry, content: NotificationContent): boolean {
		return !this.isDisposed && this.host.isEnabled() && this.entries.get(entry.key) === entry && entry.displayed === content;
	}

	private activate(entry: NotificationEntry, button?: number): void {
		const content = entry.displayed!;
		if (content.focus) this.host.focusTerminal();
		if (content.report) this.reply(`i=${entry.id || '0'}`, button === undefined ? '' : String(button));
	}

	private reply(metadata: string, payload = ''): void {
		if (!this.isDisposed && this.host.isEnabled()) this.host.writeToProcess(`\x1b]99;${metadata};${payload}\x1b\\`);
	}

	private closeEntry(entry: NotificationEntry | undefined, reason: NotificationEntry['closeReason']): void {
		if (!entry) return;
		entry.closeReason = reason;
		if (entry.timer) clearTimeout(entry.timer);
		entry.handle?.close();
		this.entries.delete(entry.key);
		entry.lifetime.dispose();
	}

	/** A process lease change or configuration disable retires every callback and timer. */
	clear(): void {
		for (const entry of [...this.entries.values()]) this.closeEntry(entry, 'dispose');
	}

	protected override disposeCore(): void {
		this.clear();
		super.disposeCore();
	}
}

function plainText(text: string): string {
	// Track nested labels in a single pass. Removing an inner link must not turn
	// the surviving outer label into an executable notification link.
	const output: string[] = [];
	const labels: number[] = [];
	let noMoreDestinations = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (character === '[') labels.push(output.length);
		if (character === ']' && labels.length && text[index + 1] === '(' && !noMoreDestinations) {
			const end = text.indexOf(')', index + 2);
			if (end >= 0) {
				output[labels.pop()!] = '';
				index = end;
				continue;
			}
			noMoreDestinations = true;
		}
		if (character === ']') labels.pop();
		const code = character.charCodeAt(0);
		if ((code >= 32 && (code < 127 || code >= 160)) || character === '\t' || character === '\n') output.push(character);
	}
	return output.join('');
}
