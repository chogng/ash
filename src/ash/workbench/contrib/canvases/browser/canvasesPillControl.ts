import './media/canvasesPillControl.css';
import { h } from '../../../../base/browser/dom.js';
import type { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { autorun, type IObservable } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { ChatPillsWidget, chatPillsRowClassName, createChatPillButton, type IChatPill } from '../../../browser/chatPills.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { getCanvasReferenceKey, type ICanvas } from '../../../common/canvasReference.js';
import { ICanvasService, getCanvasInstanceLabels, type ICanvasContext } from '../common/canvas.js';

interface CanvasPillEntry {
	context: ICanvasContext;
	canvas: ICanvas;
	label: string;
}

interface CanvasRow extends CanvasPillEntry {
	readonly close: Button;
	readonly lifetime: DisposableStore;
	closing: boolean;
}

/** Live conversation references, independent of draft attachments and their undo history. */
export class CanvasesPillControl extends Disposable {
	readonly domNode: HTMLElement;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeContent = this.changed.event;
	private content = '';

	constructor(container: HTMLElement, context: IObservable<ICanvasContext | undefined>, private readonly focusInput: () => void,
		@ICanvasService private readonly canvases: ICanvasService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div', { className: [chatPillsRowClassName, 'ash-canvas-pills'], attributes: { role: 'group', 'aria-label': localize('canvas.pills', 'Canvases') } });
		container.append(this.domNode);
		const pills = this._register(new ChatPillsWidget(this.domNode, {
			getId: ({ context, canvas }: CanvasPillEntry) => getCanvasReferenceKey({ ...context.owner, canvas: canvas.resource }),
			create: (entry: CanvasPillEntry) => this.createPill(entry),
			onRemoveFocused: this.focusInput,
		}));
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(autorun(reader => {
			const current = context.read(reader);
			const enabled = this.canvases.enabled.read(reader);
			const entries = enabled ? current?.canvases.read(reader)?.filter(canvas => canvas.source !== undefined) ?? [] : [];
			const labels = getCanvasInstanceLabels(entries);
			pills.update(current ? entries.map((canvas, index) => ({ context: current, canvas, label: labels[index]! })) : []);
			this.domNode.hidden = pills.size === 0;
			const content = entries.map((canvas, index) => canvas.status ? `${labels[index]}: ${canvas.status}` : labels[index]).join('\n');
			if (content !== this.content) { this.content = content; this.changed.fire(); }
		}));
	}

	private createPill(entry: CanvasPillEntry): IChatPill<CanvasPillEntry> {
		const lifetime = new DisposableStore();
		const element = h(this.domNode.ownerDocument, 'div', { className: 'ash-canvas-pill' });
		const open = lifetime.add(createChatPillButton(element, { label: '', presentation: 'quiet', icon: Lxicon.preview }));
		const close = lifetime.add(createChatPillButton(element, { label: '', presentation: 'quiet', icon: Lxicon.close, iconOnly: true }));
		const row: CanvasRow = { ...entry, close, lifetime, closing: false };
		lifetime.add(open.onDidClick(() => {
			void this.canvases.revealCanvas({ ...row.context.owner, canvas: row.canvas.resource }).catch(error => this.notifications.error(error));
		}));
		lifetime.add(close.onDidClick(() => void this.close(row)));
		lifetime.add(toDisposable(() => element.remove()));
		return Object.assign(lifetime, {
			element,
			update: ({ context, canvas, label }: CanvasPillEntry) => {
				row.context = context;
				row.canvas = canvas;
				row.label = label;
				open.label = label;
				open.domNode.setAttribute('aria-label', localize('canvas.openNamed', 'Open Canvas {0}', label));
				open.domNode.title = canvas.status ? `${label}: ${canvas.status}` : label;
				close.domNode.hidden = !context.closeCanvas;
				close.domNode.setAttribute('aria-label', localize('canvas.closeNamed', 'Close Canvas {0}', label));
				close.domNode.title = localize('canvas.close', 'Close Canvas');
			},
		});
	}

	getAccessibleContent(): string { return this.content; }

	private async close(row: CanvasRow): Promise<void> {
		if (row.closing || !row.context.closeCanvas || !this.canvases.isOwnerPresentable({ ...row.context.owner, canvas: row.canvas.resource })) { return; }
		row.closing = true;
		// Keep keyboard focus until removal can return it to the composer.
		row.close.domNode.setAttribute('aria-disabled', 'true');
		try { await row.context.closeCanvas(row.canvas); }
		catch (error) { this.notifications.error(localize('canvas.closeFailed', 'Could not close Canvas {0}: {1}', row.label, String(error))); }
		finally { row.closing = false; if (!this.isDisposed && !row.lifetime.isDisposed) { row.close.domNode.removeAttribute('aria-disabled'); } }
	}
}
