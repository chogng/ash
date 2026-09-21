import { IDialogService, DialogSeverity } from '../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { ICallService, type ScreenFrame, type ScreenSource } from '../../../../platform/call/common/callService.js';
import { Disposable, DisposableMap, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';

export class CallViewPane extends ViewPane {
	private readonly statusDomNode: HTMLDivElement;
	private readonly formDomNode: HTMLFormElement;
	private readonly modeDomNode: HTMLSelectElement;
	private readonly urlDomNode: HTMLInputElement;
	private readonly credentialDomNode: HTMLInputElement;
	private readonly participantsDomNode: HTMLUListElement;
	private readonly invitationDomNode: HTMLTextAreaElement;
	private readonly sourcePickerDomNode: HTMLDivElement;
	private readonly sourceDomNode: HTMLSelectElement;
	private readonly screensDomNode: HTMLDivElement;
	private readonly screenStatusDomNode: HTMLDivElement;
	private readonly screens = this._register(new DisposableMap<string, SharedScreen>());
	private sources: readonly ScreenSource[] = [];
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
			this.button('Share screen', 'share', async () => {
				this.sources = await this.calls.screenSources();
				if (this.isDisposed || this.calls.state?.connection !== 'connected') { return; }
				this.sourceDomNode.replaceChildren(...this.sources.map((source, index) => {
					const option = h(document, 'option');
					option.value = String(index);
					option.textContent = `${source.target.type === 'display' ? 'Display' : 'Window'}: ${source.title} (${source.width} × ${source.height})`;
					return option;
				}));
				if (!this.sources.length) { throw new Error('No displays or windows are available to share.'); }
				this.sourcePickerDomNode.hidden = false;
			}),
			this.button('Stop sharing', 'stop-share', () => this.calls.stopScreenShare()),
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
		this.sourcePickerDomNode = h(document, 'div');
		this.sourcePickerDomNode.className = 'call-source-picker';
		this.sourcePickerDomNode.hidden = true;
		this.sourceDomNode = h(document, 'select');
		this.field(this.sourcePickerDomNode, 'Display or window to share', this.sourceDomNode);
		this.sourcePickerDomNode.append(
			this.button('Start sharing', 'start-share', async () => {
				const source = this.sources[Number(this.sourceDomNode.value)];
				if (!source) { throw new Error('Choose a display or window.'); }
				await this.calls.shareScreen(source.target);
				this.sourcePickerDomNode.hidden = true;
			}),
			this.button('Cancel sharing', 'cancel-share', async () => { this.sourcePickerDomNode.hidden = true; }),
		);
		this._register(addDisposableListener(this.sourcePickerDomNode, 'keydown', event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				this.sourcePickerDomNode.hidden = true;
				this.buttons.get('share')?.focus();
			}
		}));
		this.screenStatusDomNode = h(document, 'div');
		this.screenStatusDomNode.className = 'call-screen-status';
		this.screenStatusDomNode.setAttribute('aria-live', 'polite');
		this.screensDomNode = h(document, 'div');
		this.screensDomNode.className = 'call-screens';
		this.screensDomNode.setAttribute('aria-label', 'Shared screens');
		this.invitationDomNode = h(document, 'textarea');
		this.invitationDomNode.readOnly = true;
		this.invitationDomNode.hidden = true;
		this.invitationDomNode.setAttribute('aria-label', 'Invitation server address and key');
		this.participantsDomNode = h(document, 'ul');
		this.participantsDomNode.setAttribute('aria-label', 'People in this call');
		this.contentElement.append(this.statusDomNode, this.formDomNode, actions, this.sourcePickerDomNode, this.screenStatusDomNode, this.screensDomNode, this.invitationDomNode, this.participantsDomNode);
		this._register(addDisposableListener(this.contentElement, 'keydown', event => {
			if (event.altKey && event.key === 'F1') { event.preventDefault(); void this.showHelp(); }
		}));
		this._register(calls.onDidChange(() => this.render()));
		this._register(calls.onDidChangeScreens(() => this.renderScreens()));
		this.render();
		this.renderScreens();
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
		await this.dialogs.showMessage({ title: 'Calls help', severity: DialogSeverity.Info, message: 'Create a call on this computer or a server, or join with an invitation. Your microphone starts off. Use Tab and Shift+Tab to move between controls and Enter or Space to activate a button. Muting stops sending audio; Stop listening stops playback. Share screen opens a display or window selector. Use arrow keys to choose a source, then Start sharing. Escape cancels selection. Stop sharing ends screen capture without leaving the call. Shared screen images are labeled by participant; their visual contents are not transcribed. Sharing stops when its window closes, the call reconnects, or you leave. Leave disconnects only you. End for everyone closes the room. Invitation keys grant access: share them only with people you want in the call. Escape closes this help.' });
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
				else if (id === 'share' && !this.sourcePickerDomNode.hidden) { this.sourceDomNode.focus(); }
				else if (id === 'start-share') { this.buttons.get('stop-share')?.focus(); }
				else if (id === 'cancel-share' || id === 'stop-share') { this.buttons.get('share')?.focus(); }
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
			if (id === 'share' || id === 'start-share') { button.disabled ||= !state?.screenAllowed || state.connection !== 'connected'; }
			if (id === 'share') { button.hidden = !!state?.screenSharing; }
			if (id === 'stop-share') { button.hidden = !state?.screenSharing; }
		}
		if (!active || state?.connection !== 'connected' || !state.screenAllowed) { this.sourcePickerDomNode.hidden = true; }
		this.renderScreens();
		if (!active) { this.invitationDomNode.value = ''; this.invitationDomNode.hidden = true; }
		const people = state?.participants ?? [];
		const document = this.contentElement.ownerDocument;
		this.participantsDomNode.replaceChildren(...people.map((person, index) => {
			const item = h(document, 'li');
			item.textContent = `Participant ${index + 1}${person.muted ? ' · microphone off' : ''}`;
			return item;
		}));
	}

	private renderScreens(): void {
		const frames = this.calls.screens;
		const activeIds = new Set(frames.map(frame => frame.trackId));
		for (const [id] of this.screens) { if (!activeIds.has(id)) { this.screens.deleteAndDispose(id); } }
		for (const frame of frames) {
			let screen = this.screens.get(frame.trackId);
			if (!screen) {
				screen = new SharedScreen(this.screensDomNode);
				this.screens.set(frame.trackId, screen);
			}
			const index = this.calls.state?.participants.findIndex(person => person.id === frame.participantId) ?? -1;
			screen.update(frame, index < 0 ? 'Shared screen' : `Participant ${index + 1} shared screen`);
		}
		const status = this.calls.screenError ?? (this.calls.state?.screenSharing ? 'You are sharing your screen.' : frames.length ? `${frames.length} shared screen${frames.length === 1 ? '' : 's'}.` : '');
		if (this.screenStatusDomNode.textContent !== status) { this.screenStatusDomNode.textContent = status; }
	}
}

class SharedScreen extends Disposable {
	private readonly imageDomNode: HTMLImageElement;
	private readonly captionDomNode: HTMLElement;
	private readonly imageUrl = this._register(new MutableDisposable());
	private frame: ScreenFrame | undefined;

	constructor(container: HTMLElement) {
		super();
		const figure = h(container.ownerDocument, 'figure');
		figure.className = 'call-screen';
		this.imageDomNode = h(container.ownerDocument, 'img');
		this.captionDomNode = h(container.ownerDocument, 'figcaption');
		figure.append(this.imageDomNode, this.captionDomNode);
		container.append(figure);
		this._register(toDisposable(() => { this.imageDomNode.removeAttribute('src'); figure.remove(); }));
	}

	public update(frame: ScreenFrame, label: string): void {
		this.imageDomNode.alt = label;
		this.captionDomNode.textContent = label;
		if (this.frame === frame) { return; }
		this.frame = frame;
		const url = URL.createObjectURL(new Blob([frame.data], { type: 'image/jpeg' }));
		this.imageDomNode.src = url;
		this.imageUrl.value = toDisposable(() => URL.revokeObjectURL(url));
	}
}
