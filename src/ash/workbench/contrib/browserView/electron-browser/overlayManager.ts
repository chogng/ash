import { addDisposableListener, type IDomNodePagePosition } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
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
	// A menu can sit outside the page while its viewport-wide dismissal shield covers it.
	['.ash-context-view-pointer-shield', BrowserOverlayType.Menu],
	['.ash-quick-input-host', BrowserOverlayType.QuickInput],
	['.ash-hover', BrowserOverlayType.Hover],
	['.ash-dialog', BrowserOverlayType.Dialog],
	['.ash-notification', BrowserOverlayType.Notification],
	['.ash-notifications-center', BrowserOverlayType.Notification],
	// Hosts mark transient layout surfaces without coupling the browser to product-specific chrome.
	['[data-browser-overlay]', BrowserOverlayType.Unknown],
]);
const overlaySelector = [...overlayRoots.keys()].join(',');
const overlayClasses = new Set([...overlayRoots.keys()].filter(selector => selector.startsWith('.')).map(selector => selector.slice(1)));

/** Tracks Workbench surfaces that must paint above the Main-owned page. */
export class BrowserOverlayManager extends Disposable {
	private readonly observation = this._register(new DisposableStore());
	private readonly changes = this._register(new Emitter<void>({
		onDidAddFirstListener: () => this.observe(),
		onDidRemoveLastListener: () => this.observation.clear(),
	}));
	public readonly onDidChangeOverlayState = this.changes.event;

	constructor(
		private readonly targetWindow: Window & typeof globalThis,
		@IContextMenuService menus: IContextMenuService,
		@IDialogsModel private readonly dialogs: IDialogsModel,
	) {
		super();
		this._register(menus.onDidShowContextMenu(() => this.changes.fire()));
		this._register(menus.onDidHideContextMenu(() => this.changes.fire()));
		this._register(dialogs.onWillShowDialog(() => this.changes.fire()));
		this._register(dialogs.onDidCloseDialog(() => this.changes.fire()));
	}

	private observe(): void {
		const targetWindow = this.targetWindow;
		const observer = new targetWindow.MutationObserver(records => {
			if (records.some(record => this.isOverlayMutation(record))) { this.changes.fire(); }
		});
		observer.observe(targetWindow.document.body, {
			subtree: true, childList: true, attributes: true, attributeOldValue: true,
			attributeFilter: ['class', 'style', 'hidden', 'data-browser-overlay'],
		});
		this.observation.add(toDisposable(() => observer.disconnect()));
		this.observation.add(addDisposableListener(targetWindow, 'resize', () => this.changes.fire()));
		this.observation.add(addDisposableListener(targetWindow.document, 'transitionend', event => {
			if (event.target instanceof targetWindow.Element && event.target.closest(overlaySelector)) { this.changes.fire(); }
		}));
	}

	public getOverlappingOverlays(element: HTMLElement): IBrowserOverlayInfo[] {
		const bounds = element.getBoundingClientRect();
		const rect = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
		// Queued modal dialogs must obscure the page before their renderer DOM exists.
		if (this.dialogs.dialogs.length > 0) { return [{ type: BrowserOverlayType.Dialog, rect }]; }
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
		const isOverlayTree = (node: Node): boolean => node instanceof this.targetWindow.Element && (node.matches(overlaySelector) || !!node.querySelector(overlaySelector));
		if (record.target instanceof this.targetWindow.Element && record.target.closest(overlaySelector)) return true;
		if (record.type === 'attributes') {
			// Removing an overlay's identifying class or marker must still reveal the page.
			if (record.attributeName === 'data-browser-overlay') return true;
			if (record.attributeName === 'class' && record.oldValue?.split(/\s+/u).some(name => overlayClasses.has(name))) return true;
			return isOverlayTree(record.target);
		}
		// A parent may contain other overlays elsewhere. Only changed subtrees matter
		// for child mutations outside an overlay, not every sibling under the parent.
		return [...record.addedNodes, ...record.removedNodes].some(isOverlayTree);
	}
}
