import { IDialogService, DialogSeverity } from '../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { ICallService } from '../../../../platform/call/common/callService.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';

export class CallViewPane extends ViewPane {
	private readonly statusDomNode: HTMLDivElement;
	private readonly formDomNode: HTMLFormElement;
	private readonly modeDomNode: HTMLSelectElement;
	private readonly urlDomNode: HTMLInputElement;
	private readonly credentialDomNode: HTMLInputElement;
	private readonly participantsDomNode: HTMLUListElement;
	private readonly invitationDomNode: HTMLTextAreaElement;
	private readonly buttons = new Map<string, HTMLButtonElement>();
	private working = false;

	constructor(container: HTMLElement, options: IViewPaneOptions, @ICallService private readonly calls: ICallService, @IDialogService private readonly dialogs: IDialogService, @IConfigurationService private readonly configuration: IConfigurationService) {
		super(container, options);
		const document = container.ownerDocument;
		this.contentElement.classList.add('ash-call');
		this.statusDomNode = h(document, 'div');
		this.statusDomNode.setAttribute('role', 'status');
		this.formDomNode = h(document, 'form');
		this.modeDomNode = h(document, 'select');
		for (const [value, label] of [['local', 'Create on this computer'], ['server', 'Create on a server'], ['invitation', 'Join with an invitation']]) {
			const option = h(document, 'option');
			option.value = value!;
			option.textContent = label!;
			this.modeDomNode.append(option);
		}
		this.field(this.formDomNode, 'Call', this.modeDomNode);
		this.urlDomNode = h(document, 'input');
		this.urlDomNode.type = 'url';
		this.field(this.formDomNode, 'Server address', this.urlDomNode);
		this.credentialDomNode = h(document, 'input');
		this.credentialDomNode.type = 'password';
		this.credentialDomNode.autocomplete = 'off';
		this.field(this.formDomNode, 'Administrator key or invitation key', this.credentialDomNode);
		const start = this.button('Join call', 'start', async () => {
			const type = this.modeDomNode.value;
			await this.calls.start(type === 'local' ? { type } : type === 'server'
				? { type, url: this.urlDomNode.value.trim(), administrator: this.credentialDomNode.value }
				: { type: 'invitation', url: this.urlDomNode.value.trim(), credential: this.credentialDomNode.value });
			this.credentialDomNode.value = '';
		});
		this.formDomNode.append(start);
		this._register(addDisposableListener(this.formDomNode, 'submit', event => { event.preventDefault(); start.click(); }));
		this._register(addDisposableListener(this.modeDomNode, 'change', () => this.render()));
		const actions = h(document, 'div');
		actions.className = 'call-actions';
		actions.append(
			this.button('Unmute microphone', 'mute', () => this.calls.mute(!this.calls.state?.muted)),
			this.button('Stop listening', 'deafen', () => this.calls.deafen(!this.calls.state?.deafened)),
			this.button('Use microphone on this device', 'device', () => this.calls.selectDevice()),
			this.button('Invite speaker', 'invite', async () => {
				const invitation = await this.calls.invite();
				this.invitationDomNode.value = `${invitation.url}\n${invitation.credential}`;
				this.invitationDomNode.hidden = false;
				this.invitationDomNode.focus();
				this.invitationDomNode.select();
			}),
			this.button('Leave call', 'leave', () => this.calls.leave()),
			this.button('End for everyone', 'end', () => this.calls.end()),
		);
		this.invitationDomNode = h(document, 'textarea');
		this.invitationDomNode.readOnly = true;
		this.invitationDomNode.hidden = true;
		this.invitationDomNode.setAttribute('aria-label', 'Invitation server address and key');
		this.participantsDomNode = h(document, 'ul');
		this.participantsDomNode.setAttribute('aria-label', 'People in this call');
		this.contentElement.append(this.statusDomNode, this.formDomNode, actions, this.invitationDomNode, this.participantsDomNode);
		this._register(addDisposableListener(this.contentElement, 'keydown', event => {
			if (event.altKey && event.key === 'F1') { event.preventDefault(); void this.showHelp(); }
		}));
		this._register(calls.onDidChange(() => this.render()));
		this.render();
	}

	public override focus(): void {
		if (!this.formDomNode.hidden) { this.modeDomNode.focus(); }
		else { this.buttons.get('leave')?.focus(); }
		if (this.configuration.getValue<boolean>('accessibility.verbosity.calls')) {
			this.statusDomNode.textContent += ' Use Tab to navigate and Alt+F1 for help.';
		}
	}

	private async showHelp(): Promise<void> {
		const focus = this.element.ownerDocument.activeElement;
		await this.dialogs.showMessage({ title: 'Calls help', severity: DialogSeverity.Info, message: 'Create a call on this computer or a server, or join with an invitation. Your microphone starts off. Use Tab and Shift+Tab to move between controls and Enter or Space to activate a button. Muting stops sending audio; Stop listening stops playback. Leave disconnects only you. End for everyone closes the room. Invitation keys grant access: share them only with people you want in the call. Escape closes this help.' });
		if (focus instanceof HTMLElement && focus.isConnected) { focus.focus(); }
	}

	private field(container: HTMLElement, name: string, control: HTMLElement): void {
		const label = h(container.ownerDocument, 'label');
		const text = h(container.ownerDocument, 'span');
		text.textContent = name;
		control.setAttribute('aria-label', name);
		label.append(text, control);
		container.append(label);
	}

	private button(label: string, id: string, action: () => Promise<void>): HTMLButtonElement {
		const button = h(this.contentElement.ownerDocument, 'button');
		button.type = 'button';
		button.textContent = label;
		this.buttons.set(id, button);
		this._register(addDisposableListener(button, 'click', () => {
			if (this.working) { return; }
			this.working = true;
			this.render();
			void action().then(() => {
				this.working = false;
				if (this.isDisposed) { return; }
				this.render();
				if (id === 'start' && this.formDomNode.hidden) { this.buttons.get('leave')?.focus(); }
				else if (!button.disabled && !button.hidden) { button.focus(); }
			}, error => {
				this.working = false;
				if (this.isDisposed) { return; }
				this.render();
				button.focus();
				this.statusDomNode.textContent = error instanceof Error ? error.message : 'Could not update the call.';
			});
		}));
		return button;
	}

	private render(): void {
		const state = this.calls.state;
		const active = !!state && !['ended', 'failed'].includes(state.connection);
		const local = this.modeDomNode.value === 'local';
		this.urlDomNode.parentElement!.hidden = local;
		this.credentialDomNode.parentElement!.hidden = local;
		this.formDomNode.hidden = active;
		this.statusDomNode.textContent = state?.error ?? (state ? `${state.connection} · ${state.muted ? 'Microphone off' : 'Microphone on'}` : 'Start a call. Your microphone stays off until you unmute.');
		for (const [id, button] of this.buttons) {
			button.disabled = this.working || (id === 'start' ? active : !active);
			if (id === 'invite' || id === 'end') { button.hidden = !state?.canManage; }
			if (id === 'mute') {
				button.textContent = state?.muted !== false ? 'Unmute microphone' : 'Mute microphone';
				button.disabled ||= !state?.microphoneAllowed;
				button.setAttribute('aria-pressed', String(!state?.muted && active));
			}
			if (id === 'deafen') { button.textContent = state?.deafened ? 'Resume listening' : 'Stop listening'; }
		}
		if (!active) { this.invitationDomNode.value = ''; this.invitationDomNode.hidden = true; }
		const people = state?.participants ?? [];
		const document = this.contentElement.ownerDocument;
		this.participantsDomNode.replaceChildren(...people.map((person, index) => {
			const item = h(document, 'li');
			item.textContent = `Participant ${index + 1}${person.muted ? ' · microphone off' : ''}`;
			return item;
		}));
	}
}
