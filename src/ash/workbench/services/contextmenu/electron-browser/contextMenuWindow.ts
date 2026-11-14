import type { ContextMenuAnchor } from '../../../../base/browser/contextmenu.js';
import { addDisposableListener, isNode } from '../../../../base/browser/dom.js';
import { cloneDocumentStyles } from '../../../../base/browser/domStylesheets.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { CodeWindow } from '../../../../base/browser/window.js';
import { CONTEXT_MENU_WINDOW_NAME_PREFIX, type INativeContextMenuApi } from '../../../../base/parts/contextmenu/common/contextmenu.js';
import { localize } from '../../../../nls.js';
import './media/contextMenuWindow.css';

/** A trusted DOM mount above native page views; the menu service still owns its actions. */
export class ContextMenuWindow extends Disposable {
	readonly window: Window;
	readonly container: HTMLElement;
	readonly whenReady: Promise<void>;
	private readonly source: CodeWindow;
	private readonly sourceFocus: HTMLElement | undefined;
	private readonly anchorBounds: DOMRect;
	private readonly zoom: number;
	private readonly windowName: string;

	constructor(
		anchor: ContextMenuAnchor,
		sourceContainer: HTMLElement,
		private readonly present: INativeContextMenuApi['presentWindow'],
	) {
		super();
		const sourceDocument = isNode(anchor) ? anchor.ownerDocument! : (anchor.targetWindow?.document ?? sourceContainer.ownerDocument);
		this.source = sourceDocument.defaultView! as CodeWindow;
		this.sourceFocus = anchor instanceof this.source.HTMLElement ? anchor :
			sourceDocument.activeElement instanceof this.source.HTMLElement ? sourceDocument.activeElement : undefined;
		this.anchorBounds = isNode(anchor) ? (anchor as Element).getBoundingClientRect() : new this.source.DOMRect(anchor.x, anchor.y, 0, 0);
		this.windowName = CONTEXT_MENU_WINDOW_NAME_PREFIX + generateUuid();
		const target = this.source.open('about:blank', this.windowName, 'popup=yes');
		if (!target) throw new Error(localize({ bundle: 'ash.workbench', key: 'contextMenu.windowUnavailable' }, 'Unable to open menu.'));
		this.window = target;
		this.zoom = this.source.devicePixelRatio / target.devicePixelRatio;
		this._register(toDisposable(() => { if (!target.closed) target.close(); }));
		try {
			const document = target.document;
			document.title = sourceDocument.title;
			document.documentElement.classList.add('ash-context-menu-window');
			// The surface sizes to its menu; using its own viewport as the menu's limit would shrink it again after resize.
			document.documentElement.style.setProperty('--ash-context-menu-window-max-width', `${this.source.screen.availWidth / this.zoom - 8}px`);
			document.documentElement.style.setProperty('--ash-context-menu-window-max-height', `${this.source.screen.availHeight / this.zoom - 8}px`);
			const syncTheme = (): void => {
				for (const attribute of ['lang', 'dir', 'data-color-theme', 'data-color-scheme']) {
					const value = sourceDocument.documentElement.getAttribute(attribute);
					if (value === null) document.documentElement.removeAttribute(attribute);
					else document.documentElement.setAttribute(attribute, value);
				}
				for (const name of ['hc-black', 'hc-light', 'ash-high-contrast']) {
					document.documentElement.classList.toggle(name, sourceDocument.documentElement.classList.contains(name));
				}
			};
			syncTheme();
			const themeObserver = new this.source.MutationObserver(syncTheme);
			themeObserver.observe(sourceDocument.documentElement, { attributes: true, attributeFilter: ['class', 'lang', 'dir', 'data-color-theme', 'data-color-scheme'] });
			this._register(toDisposable(() => themeObserver.disconnect()));
			// A fresh about:blank document inherits the source origin, not its styling.
			const base = document.createElement('base');
			base.href = sourceDocument.baseURI;
			document.head.append(base);
			const styles = this._register(cloneDocumentStyles(sourceDocument, document));
			const root = sourceContainer.cloneNode(false) as HTMLElement;
			root.removeAttribute('id');
			root.classList.add('ash-context-menu-window-content');
			root.style.zoom = String(this.zoom);
			document.body.append(root);
			this.container = root;
			this.whenReady = styles.whenStylesHaveLoaded;
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	private screenOrigin(): { x: number; y: number; } {
		const topInset = Math.max(0, this.source.outerHeight - this.source.innerHeight * this.zoom);
		return { x: this.source.screenX + this.anchorBounds.left * this.zoom, y: this.source.screenY + topInset + this.anchorBounds.bottom * this.zoom };
	}

	async layout(menu: HTMLElement): Promise<void> {
		if (this.isDisposed || this.window.closed) return;
		const rect = menu.getBoundingClientRect();
		const width = Math.ceil(rect.width + 8 * this.zoom);
		const height = Math.ceil(rect.height + 8 * this.zoom);
		const origin = this.screenOrigin();
		const right = this.source.screenX + this.anchorBounds.right * this.zoom;
		const alignRight = this.anchorBounds.left > this.source.innerWidth / 2;
		const screen = this.source.screen;
		const areaLeft = 'availLeft' in screen && typeof screen.availLeft === 'number' ? screen.availLeft : 0;
		const areaTop = 'availTop' in screen && typeof screen.availTop === 'number' ? screen.availTop : 0;
		const left = Math.max(areaLeft, Math.min(alignRight ? right - width : origin.x, areaLeft + screen.availWidth - width));
		const top = Math.max(areaTop, Math.min(origin.y, areaTop + screen.availHeight - height));
		// Main owns visibility and applies these measured bounds before the first show.
		const shown = await this.present({
			windowName: this.windowName,
			bounds: { x: Math.round(left), y: Math.round(top), width, height },
		});
		if (!shown && !this.isDisposed && !this.window.closed) {
			throw new Error(localize({ bundle: 'ash.workbench', key: 'contextMenu.windowUnavailable' }, 'Unable to open menu.'));
		}
	}

	onBlur(listener: () => void): void {
		this._register(addDisposableListener(this.window, 'blur', listener));
		this._register(addDisposableListener(this.window, 'pagehide', listener));
	}

	restoreSourceFocus(): void {
		if (!this.source.closed && this.sourceFocus?.isConnected) {
			this.source.focus();
			this.sourceFocus.focus();
		}
	}
}
