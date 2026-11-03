import '../media/chatToolConfirmationCarousel.css';
import { h } from '../../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../../base/browser/ui/button/button.js';
import { Disposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { defaultButtonStyles } from '../../../../../../../platform/theme/browser/defaultStyles.js';
import { localize } from '../../../../../../../nls.js';
import type { IChatToolInvocation } from '../../../../common/chatService/chatService.js';

/** Reviews adjacent calls while keeping exactly one actionable offer and one set of controls. */
export class ChatToolConfirmationCarouselPart extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly label: HTMLElement;
	private readonly preview: HTMLElement;
	private readonly live: HTMLElement;
	private readonly previous: Button;
	private readonly next: Button;
	private readonly current: Button;
	private items: readonly IChatToolInvocation[] = [];
	private selectedId: string | undefined;
	private currentId: string | undefined;

	constructor(document: Document, content: HTMLElement) {
		super();
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-chat-rich-tool-confirmation';
		this.domNode.setAttribute('aria-label', localize('chat.tool.confirmationCalls', 'Tool calls in this turn'));
		const controls = h(document, 'div');
		controls.className = 'ash-chat-interaction-actions';
		this.previous = this._register(new Button(controls, { ...defaultButtonStyles, label: localize('chat.tool.previousCall', 'Previous tool'), onClick: () => this.move(-1) }));
		this.label = h(document, 'span');
		this.label.setAttribute('aria-live', 'polite');
		controls.append(this.label);
		this.next = this._register(new Button(controls, { ...defaultButtonStyles, label: localize('chat.tool.nextCall', 'Next tool'), onClick: () => this.move(1) }));
		this.current = this._register(new Button(controls, { ...defaultButtonStyles, label: localize('chat.tool.currentApproval', 'Return to current approval'), onClick: () => this.showCurrent() }));
		this.preview = h(document, 'pre');
		this.preview.tabIndex = 0;
		this.preview.setAttribute('role', 'region');
		this.preview.setAttribute('aria-label', localize('chat.tool.callEvidence', 'Read-only tool evidence'));
		this.live = h(document, 'div');
		this.live.append(content);
		this.domNode.append(controls, this.preview, this.live);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public get isCurrentSelected(): boolean { return this.selectedId === this.currentId; }
	public focusCurrentConfirmation(): boolean {
		this.showCurrent();
		const control = this.live.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)');
		if (!control) return false;
		control.focus({ preventScroll: true });
		return true;
	}
	public showCurrent(): void { this.selectedId = this.currentId; this.update(); }
	public render(items: readonly IChatToolInvocation[], currentId: string): void {
		this.items = items;
		if (currentId !== this.currentId || !items.some(item => item.call.itemId === this.selectedId)) this.selectedId = currentId;
		this.currentId = currentId;
		this.update();
	}
	private move(delta: number): void {
		const index = this.items.findIndex(item => item.call.itemId === this.selectedId);
		this.selectedId = this.items[Math.max(0, Math.min(this.items.length - 1, index + delta))]?.call.itemId;
		this.update();
	}
	private update(): void {
		const index = this.items.findIndex(item => item.call.itemId === this.selectedId);
		const item = this.items[index];
		this.label.textContent = localize('chat.tool.callPosition', 'Tool {0} of {1}', index + 1, this.items.length);
		this.previous.enabled = index > 0;
		this.next.enabled = index >= 0 && index < this.items.length - 1;
		this.current.enabled = !this.isCurrentSelected;
		this.live.hidden = !this.isCurrentSelected;
		this.preview.hidden = this.isCurrentSelected;
		this.preview.textContent = item ? [item.call.name, item.call.argumentsJson, item.result?.text].filter(value => value !== undefined).join('\n\n') : '';
	}
}
