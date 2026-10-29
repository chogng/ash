import { addDisposableListener, type IDomNodePagePosition } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogsModel } from '../../../common/dialogs.js';

export enum BrowserOverlayType {
	Menu = 'menu',
	QuickInput = 'quickInput',
	Hover = 'hover',
	Dialog = 'dialog',
	Notification = 'notification',
	Unknown = 'unknown',
}

export interface IBrowserOverlayInfo {
	readonly type: BrowserOverlayType;
	readonly rect: IDomNodePagePosition;
}

const overlayRoots = new Map<string, BrowserOverlayType>([
	['.ash-context-view', BrowserOverlayType.Menu],
	['.ash-quick-input-host', BrowserOverlayType.QuickInput],
	['.ash-hover', BrowserOverlayType.Hover],
	['.ash-dialog', BrowserOverlayType.Dialog],
	['.ash-notification', BrowserOverlayType.Notification],
	['.ash-notifications-center', BrowserOverlayType.Notification],
]);
const overlaySelector = [...overlayRoots.keys()].join(',');

/** Tracks Workbench surfaces that must paint above the Main-owned page. */
export class BrowserOverlayManager extends Disposable {
	private readonly changes = this._register(new Emitter<void>());
	public readonly onDidChangeOverlayState = this.changes.event;
	private menuVisible = false;

	constructor(
		private readonly targetWindow: Window & typeof globalThis,
		@IContextMenuService menus: IContextMenuService,
		@IDialogsModel private readonly dialogs: IDialogsModel,
	) {
		super();
		this._register(menus.onDidShowContextMenu(() => { this.menuVisible = true; this.changes.fire(); }));
		this._register(menus.onDidHideContextMenu(() => { this.menuVisible = false; this.changes.fire(); }));
		this._register(dialogs.onWillShowDialog(() => this.changes.fire()));
		this._register(dialogs.onDidCloseDialog(() => this.changes.fire()));
		const observer = new targetWindow.MutationObserver(records => {
			// Page-state rendering is unrelated to overlays and must not schedule another IPC update.
			if (records.some(record => this.isOverlayMutation(record))) { this.changes.fire(); }
		});
		observer.observe(targetWindow.document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
		this._register(toDisposable(() => observer.disconnect()));
		this._register(addDisposableListener(targetWindow, 'resize', () => this.changes.fire()));
		this._register(addDisposableListener(targetWindow.document, 'transitionend', event => {
			if (event.target instanceof targetWindow.Element && event.target.closest(overlaySelector)) { this.changes.fire(); }
		}));
	}

	public getOverlappingOverlays(element: HTMLElement): IBrowserOverlayInfo[] {
		const bounds = element.getBoundingClientRect();
		const rect = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
		// OS menus and queued dialogs can obscure the page before their renderer DOM exists.
		if (this.dialogs.dialogs.length > 0) { return [{ type: BrowserOverlayType.Dialog, rect }]; }
		if (this.menuVisible) { return [{ type: BrowserOverlayType.Menu, rect }]; }
		const overlays: IBrowserOverlayInfo[] = [];
		for (const overlay of this.targetWindow.document.querySelectorAll<HTMLElement>(overlaySelector)) {
			if (overlay.closest('[hidden]')) { continue; }
			const style = this.targetWindow.getComputedStyle(overlay);
			if (style.display === 'none' || style.visibility === 'hidden') { continue; }
			const candidate = overlay.getBoundingClientRect();
			if (candidate.width <= 0 || candidate.height <= 0 || candidate.right <= bounds.left || candidate.left >= bounds.right || candidate.bottom <= bounds.top || candidate.top >= bounds.bottom) { continue; }
			const type = [...overlayRoots].find(([selector]) => overlay.matches(selector))![1];
			overlays.push({ type, rect: { left: candidate.left, top: candidate.top, width: candidate.width, height: candidate.height } });
		}
		return overlays;
	}

	private isOverlayMutation(record: MutationRecord): boolean {
		const isOverlay = (node: Node): boolean => node instanceof this.targetWindow.Element && (node.matches(overlaySelector) || !!node.closest(overlaySelector) || !!node.querySelector(overlaySelector));
		return isOverlay(record.target) || [...record.addedNodes, ...record.removedNodes].some(isOverlay);
	}
}
