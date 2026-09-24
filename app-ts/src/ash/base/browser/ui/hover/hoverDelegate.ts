import type { AnchorAlignment, AnchorAxisAlignment, AnchorPosition } from "../contextview/contextview.js";
import type { HoverContent, HoverPersistence } from "./hover.js";
import type { IDisposable } from "../../../common/lifecycle.js";
import { toDisposable } from "../../../common/lifecycle.js";

/** Base-owned inputs understood by any managed Hover implementation. */
export interface HoverDelegateSetupOptions {
	readonly target: HTMLElement;
	readonly content: HoverContent;
	readonly groupId?: string;
	readonly persistence?: HoverPersistence;
	readonly anchorAlignment?: AnchorAlignment;
	readonly anchorAxisAlignment?: AnchorAxisAlignment;
	readonly anchorPosition?: AnchorPosition;
	readonly gap?: number;
}

/** Mutable handle shared by base controls and the Workbench Hover service. */
export interface IManagedHover extends IDisposable {
	readonly visible: boolean;

	show(): void;
	hide(): void;
	update(content: HoverContent): void;
}

/**
 * Installs managed Hovers for base controls without depending on a platform
 * service implementation.
 */
export interface IHoverDelegate {
	setupHover(options: HoverDelegateSetupOptions): IManagedHover;
}

const defaultHoverDelegate: IHoverDelegate = {
	setupHover: (options) => new NativeTitleHover(
		options.target,
		options.content,
	),
};

let hoverDelegate = defaultHoverDelegate;

export function getHoverDelegate(): IHoverDelegate {
	return hoverDelegate;
}

/** Installs a process-local delegate and restores the previous one on dispose. */
export function setHoverDelegate(delegate: IHoverDelegate): IDisposable {
	const previous = hoverDelegate;
	hoverDelegate = delegate;
	return toDisposable(() => {
		if (hoverDelegate === delegate) hoverDelegate = previous;
	});
}

/** Native-title fallback for base controls used before Workbench startup. */
class NativeTitleHover implements IManagedHover {
	readonly visible = false;
	private readonly previousTitle: string | null;
	private disposed = false;

	constructor(private readonly target: HTMLElement, content: HoverContent) {
		this.previousTitle = target.getAttribute("title");
		this.update(content);
	}

	show(): void {}

	hide(): void {}

	update(content: HoverContent): void {
		if (this.disposed) return;
		const value = typeof content === "function" ? content() : content;
		const title = typeof value === "string" ? value : value?.textContent;
		if (title) {
			this.target.setAttribute("title", title);
		} else {
			this.target.removeAttribute("title");
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.previousTitle === null) {
			this.target.removeAttribute("title");
		} else {
			this.target.setAttribute("title", this.previousTitle);
		}
	}

	[Symbol.dispose](): void {
		this.dispose();
	}
}
