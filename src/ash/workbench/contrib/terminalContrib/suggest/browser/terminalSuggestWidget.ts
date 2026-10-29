import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { List } from '../../../../../base/browser/ui/list/listWidget.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import type { IXtermTerminal } from '../../../terminal/browser/terminal.js';
import type { ITerminalWidget } from '../../../terminal/browser/widgets/widgets.js';
import './media/terminalSuggestWidget.css';

const SuggestionRowHeight = 22;

/** A transient presentation of query results; input and history stay with the terminal. */
export class TerminalSuggestWidget<T extends { readonly label: string; readonly description?: string }> extends Disposable implements ITerminalWidget {
	readonly id = 'terminal.suggest.widget';
	private readonly element: HTMLDivElement;
	private readonly list: List<T>;
	private readonly footer: HTMLDivElement;
	private previousAria: Map<string, string | null> | undefined;
	private accept: ((item: T) => void) | undefined;
	constructor(
		private readonly screen: IXtermTerminal,
		private readonly dismissed: () => void,
	) {
		super();
		const document = screen.element.ownerDocument;
		this.element = document.createElement('div');
		this.element.className = 'ash-terminal-suggest';
		this.element.hidden = true;
		const instructions = localize('terminal.suggest.instructions', 'Enter inserts without running. Tab completes in the shell. Escape closes suggestions.');
		const listHost = document.createElement('div');
		this.element.append(listHost);
		this.list = this._register(
			new List<T>(listHost, {
				ariaLabel: localize('terminal.suggest.ariaLabel', 'Terminal suggestions'),
				role: 'listbox',
				domFocusable: false,
				keyboardNavigation: false,
				scrolling: 'managed',
				acceptOnClick: true,
				getHeight: () => SuggestionRowHeight,
				accessibilityProvider: { getAriaLabel: item => item.label },
				renderItem: item => {
					const row = document.createElement('div');
					row.className = 'ash-terminal-suggest-item';
					row.title = item.description ? `${item.label} — ${item.description}` : item.label;
					const label = document.createElement('span');
					label.textContent = item.label;
					row.append(label);
					if (item.description) {
						const detail = document.createElement('span');
						detail.className = 'ash-terminal-suggest-detail';
						detail.textContent = item.description;
						row.append(detail);
					}
					return row;
				},
			}),
		);
		const footer = (this.footer = document.createElement('div'));
		footer.title = instructions;
		footer.className = 'ash-terminal-suggest-instructions';
		footer.textContent = instructions;
		this.element.append(footer);
		this._register(
			this.list.onDidAccept(event => {
				if (event.item) this.accept?.(event.item);
			}),
		);
		this._register(this.list.onDidChangeActive(() => this.syncAria()));
		this._register(this.list.onDidRenderRows(() => this.syncAria()));
		this._register(
			addDisposableListener(
				screen.element,
				'keydown',
				(event: KeyboardEvent) => {
					if (this.element.hidden || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
					if (event.key === 'ArrowDown') this.list.focusNext(event);
					else if (event.key === 'ArrowUp') this.list.focusPrevious(event);
					else if (event.key === 'Enter') {
						const item = this.list.activeItem;
						if (item) this.accept?.(item);
					} else if (event.key === 'Escape') this.dismissed();
					else return;
					event.preventDefault();
					event.stopPropagation();
				},
				true,
			),
		);
		this._register(
			toDisposable(() => {
				this.hide();
				this.element.remove();
			}),
		);
		const attachment = screen.attachWidget(this);
		if (attachment) this._register(attachment);
	}
	attach(container: HTMLElement): void {
		container.append(this.element);
	}
	show(items: readonly T[], accept: (item: T) => void): void {
		if (!items.length) {
			this.hide();
			return;
		}
		this.accept = accept;
		if (!this.previousAria && this.screen.raw.textarea)
			this.previousAria = new Map(['aria-controls', 'aria-expanded', 'aria-activedescendant', 'aria-autocomplete'].map(name => [name, this.screen.raw.textarea!.getAttribute(name)]));
		this.element.hidden = false;
		this.list.items = items;
		const bounds = this.screen.element.querySelector('.xterm-screen')?.getBoundingClientRect();
		const parent = this.element.parentElement?.getBoundingClientRect();
		if (!bounds || !parent || !parent.height || !parent.width) {
			this.hide();
			return;
		}
		const raw = this.screen.raw;
		const row = raw.buffer.active.baseY + raw.buffer.active.cursorY - raw.buffer.active.viewportY;
		const rowHeight = bounds.height / raw.rows;
		this.element.style.maxWidth = `${parent.width}px`;
		const cursorTop = bounds.top - parent.top + row * rowHeight;
		const below = cursorTop + rowHeight;
		const belowSpace = Math.max(0, parent.height - below);
		const aboveSpace = Math.max(0, cursorTop);
		const above = aboveSpace > belowSpace;
		const available = Math.min(parent.height, Math.max(belowSpace, aboveSpace));
		// Fit complete rows and the instruction line into this split's actual viewport.
		const overhead = this.footer.offsetHeight + 2;
		const rows = Math.max(1, Math.min(items.length, 6, Math.floor((available - overhead) / SuggestionRowHeight)));
		this.list.layout(rows * SuggestionRowHeight);
		const cursorLeft = bounds.left - parent.left + (raw.buffer.active.cursorX * bounds.width) / raw.cols;
		this.element.style.left = `${Math.max(0, Math.min(cursorLeft, parent.width - this.element.offsetWidth))}px`;
		const top = above ? cursorTop - this.element.offsetHeight : below;
		this.element.style.top = `${Math.max(0, Math.min(top, parent.height - this.element.offsetHeight))}px`;
		this.syncAria();
		status(
			localize(
				'terminal.suggest.available',
				'{0} terminal suggestions. {1}',
				items.length,
				localize('terminal.suggest.instructions', 'Enter inserts without running. Tab completes in the shell. Escape closes suggestions.'),
			),
		);
	}
	hide(): void {
		this.element.hidden = true;
		this.accept = undefined;
		const input = this.screen.raw.textarea;
		if (input?.getAttribute('aria-controls') === this.list.element.id) {
			for (const [name, value] of this.previousAria ?? []) {
				if (value === null) input.removeAttribute(name);
				else input.setAttribute(name, value);
			}
		}
		this.previousAria = undefined;
	}
	private syncAria(): void {
		if (this.element.hidden) return;
		const input = this.screen.raw.textarea;
		input?.setAttribute('aria-autocomplete', 'list');
		input?.setAttribute('aria-controls', this.list.element.id);
		input?.setAttribute('aria-expanded', 'true');
		const active = this.list.element.getAttribute('aria-activedescendant');
		if (active) input?.setAttribute('aria-activedescendant', active);
	}
}
