import './media/canvasesPillControl.css';
import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { autorun, type IObservable } from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICanvasService, getCanvasInstanceLabels, getCanvasReferenceKey, type ICanvas, type ICanvasContext } from '../common/canvas.js';

interface CanvasRow {
	readonly element: HTMLElement;
	readonly open: Button;
	readonly close: Button;
	readonly lifetime: DisposableStore;
	context: ICanvasContext;
	canvas: ICanvas;
	label: string;
	closing: boolean;
}

/** Live conversation references, independent of draft attachments and their undo history. */
export class CanvasesPillControl extends Disposable {
	readonly domNode: HTMLElement;
	private readonly rows = new Map<string, CanvasRow>();
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeContent = this.changed.event;
	private content = '';

	constructor(container: HTMLElement, context: IObservable<ICanvasContext | undefined>, private readonly focusInput: () => void,
		@ICanvasService private readonly canvases: ICanvasService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div', { className: 'ash-canvas-pills', attributes: { role: 'group', 'aria-label': localize('canvas.pills', 'Canvases') } });
		container.append(this.domNode);
		this._register(toDisposable(() => { for (const row of this.rows.values()) { row.lifetime.dispose(); } this.rows.clear(); this.domNode.remove(); }));
		this._register(autorun(reader => {
			const current = context.read(reader);
			const entries = this.canvases.enabled.read(reader) ? current?.canvases.read(reader)?.filter(canvas => canvas.source !== undefined) ?? [] : [];
			const labels = getCanvasInstanceLabels(entries);
			const active = new Set<string>();
			for (const [index, canvas] of entries.entries()) {
				const key = getCanvasReferenceKey({ ...current!.owner, canvas: canvas.resource });
				active.add(key);
				let row = this.rows.get(key);
				if (!row) {
					const lifetime = new DisposableStore();
					const element = h(container.ownerDocument, 'div', { className: 'ash-canvas-pill' });
					const open = lifetime.add(new Button(element, { ...defaultButtonStyles, label: '', size: 'small', presentation: 'quiet', icon: Lxicon.preview }));
					const close = lifetime.add(new Button(element, { ...defaultButtonStyles, label: '', size: 'small', presentation: 'quiet', icon: Lxicon.close, iconOnly: true }));
					row = { element, open, close, lifetime, context: current!, canvas, label: labels[index]!, closing: false };
					const target = row;
					lifetime.add(open.onDidClick(() => {
						void this.canvases.revealCanvas({ ...target.context.owner, canvas: target.canvas.resource }).catch(error => this.notifications.error(error));
					}));
					lifetime.add(close.onDidClick(() => void this.close(target)));
					this.rows.set(key, row);
					this.domNode.append(element);
				}
				row.context = current!;
				row.canvas = canvas;
				row.label = labels[index]!;
				row.open.label = row.label;
				row.open.domNode.setAttribute('aria-label', localize('canvas.openNamed', 'Open Canvas {0}', row.label));
				row.open.domNode.title = canvas.status ? `${row.label}: ${canvas.status}` : row.label;
				row.close.domNode.hidden = !current!.closeCanvas;
				row.close.domNode.setAttribute('aria-label', localize('canvas.closeNamed', 'Close Canvas {0}', row.label));
				row.close.domNode.title = localize('canvas.close', 'Close Canvas');
			}
			for (const [key, row] of this.rows) {
				if (active.has(key)) { continue; }
				if (row.element.contains(container.ownerDocument.activeElement)) { this.focusInput(); }
				row.lifetime.dispose(); row.element.remove(); this.rows.delete(key);
			}
			this.domNode.hidden = this.rows.size === 0;
			const content = entries.map((canvas, index) => canvas.status ? `${labels[index]}: ${canvas.status}` : labels[index]).join('\n');
			if (content !== this.content) { this.content = content; this.changed.fire(); }
		}));
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
