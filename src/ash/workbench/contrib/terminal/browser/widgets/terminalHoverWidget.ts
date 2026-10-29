import type { IViewportRange } from '@xterm/xterm';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IHoverService } from '../../../../../platform/hover/browser/hoverService.js';
import type { ITerminalWidget } from './widgets.js';

export interface ILinkHoverTargetOptions {
	readonly viewportRange: IViewportRange;
	readonly cellDimensions: { readonly width: number; readonly height: number };
	readonly terminalDimensions: { readonly width: number; readonly height: number };
}

/** Uses public cell coordinates; the shared Hover service owns presentation and Escape. */
export class TerminalHover extends Disposable implements ITerminalWidget {
	readonly id = 'hover';

	constructor(
		private readonly target: ILinkHoverTargetOptions,
		private readonly text: string,
		@IHoverService private readonly hover: IHoverService,
	) {
		super();
	}

	attach(container: HTMLElement): void {
		this.assertNotDisposed();
		const anchor = container.ownerDocument.createElement('span');
		anchor.className = 'ash-terminal-link-hover-target';
		anchor.setAttribute('aria-hidden', 'true');
		const { viewportRange: range, cellDimensions: cell, terminalDimensions: terminal } = this.target;
		const screenRect = container.parentElement?.querySelector('.xterm-screen')?.getBoundingClientRect();
		const containerRect = container.getBoundingClientRect();
		const startX = range.start.y === range.end.y ? (range.start.x - 1) * cell.width : 0;
		const endX = range.start.y === range.end.y ? range.end.x * cell.width : terminal.width;
		anchor.style.left = `${startX + (screenRect ? screenRect.left - containerRect.left : 0)}px`;
		anchor.style.top = `${(range.start.y - 1) * cell.height + (screenRect ? screenRect.top - containerRect.top : 0)}px`;
		anchor.style.width = `${Math.max(cell.width, endX - startX)}px`;
		anchor.style.height = `${(range.end.y - range.start.y + 1) * cell.height}px`;
		container.append(anchor);
		this._register(toDisposable(() => anchor.remove()));
		this._register(
			this.hover.showHover({
				target: anchor,
				content: this.text,
				groupId: 'terminal-links',
				setupKeyboardEvents: false,
			}),
		);
	}
}
