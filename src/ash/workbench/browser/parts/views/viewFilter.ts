import './media/paneviewlet.css';
import { addDisposableListener, getActiveDocument, h } from '../../../../base/browser/dom.js';
import { HistoryInputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Emitter } from '../../../../base/common/event.js';
import type { IHistory } from '../../../../base/common/history.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { registerAndCreateHistoryNavigationContext } from '../../../../platform/history/browser/contextScopedHistoryWidget.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';

export interface IFilterWidgetOptions {
	readonly text?: string;
	readonly placeholder?: string;
	readonly ariaLabel?: string;
	readonly history?: string[] | IHistory<string>;
}

/** Owns a view's filter input and history; its consumer owns the filtered data. */
export class FilterWidget extends Disposable {
	readonly element: HTMLElement;
	private readonly input: HistoryInputBox;
	private readonly badge: HTMLSpanElement;
	private readonly changed = this._register(new Emitter<string>());
	readonly onDidChangeFilterText = this.changed.event;
	private readonly accepted = this._register(new Emitter<void>());
	readonly onDidAcceptFilterText = this.accepted.event;

	constructor(options: IFilterWidgetOptions, @IContextKeyService contextKeys: IContextKeyService) {
		super();
		const document = getActiveDocument();
		this.element = h(document, 'div');
		this.element.className = 'ash-view-filter';
		this._register(toDisposable(() => this.element.remove()));
		this.input = this._register(new HistoryInputBox(this.element, {
			presentation: 'compact',
			placeholder: options.placeholder,
			ariaLabel: options.ariaLabel ?? options.placeholder,
			history: Array.isArray(options.history) ? new Set(options.history) : options.history,
			showHistoryHint: () => true,
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this.input.value = options.text ?? '';
		this.input.inputElement.maxLength = 32_768;
		this.badge = h(document, 'span');
		this.badge.className = 'ash-view-filter-badge';
		this.badge.hidden = true;
		this.badge.setAttribute('role', 'status');
		this.badge.setAttribute('aria-atomic', 'true');
		this.element.append(this.badge);
		const scope = this._register(contextKeys.createScoped(this.element));
		this._register(registerAndCreateHistoryNavigationContext(scope, this.input));
		this._register(this.input.onDidChange(value => this.changed.fire(value)));
		this._register(addDisposableListener(this.input.inputElement, 'keydown', event => {
			if (event.isComposing || event.ctrlKey || event.metaKey || event.shiftKey) return;
			if (event.key === 'Enter' && !event.altKey) {
				event.preventDefault();
				event.stopPropagation();
				this.input.addToHistory();
				this.accepted.fire();
			} else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
				if (event.key === 'ArrowDown' && this.input.isNowhereInHistory()) return;
				event.preventDefault();
				event.stopPropagation();
				if (event.key === 'ArrowUp') this.input.showPreviousValue();
				else this.input.showNextValue();
				this.input.inputElement.setSelectionRange(this.input.value.length, this.input.value.length);
			}
		}));
	}

	focus(): void { this.input.focus(); }
	hasFocus(): boolean { return this.input.hasFocus(); }
	setFilterText(text: string): void { this.input.value = text; }
	getFilterText(): string { return this.input.value; }
	getHistory(): string[] { return this.input.getHistory(); }

	updateBadge(message: string | undefined): void {
		const text = message ?? '';
		if (this.badge.textContent === text) return;
		this.badge.textContent = text;
		this.badge.hidden = !message;
		this.badge.title = text;
	}

	layout(width: number): void {
		this.element.style.maxWidth = `${Math.max(0, width)}px`;
	}
}
