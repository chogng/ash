import { h, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { ActionBar } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { LabelActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ContextScopedFindInput, ContextScopedReplaceInput } from '../../../../platform/history/browser/contextScopedHistoryWidget.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ISearchHistoryService } from '../common/searchHistoryService.js';
import { localize } from '../../../../nls.js';

const queryOptionLabels: Readonly<Record<string, string>> = {
	'search.matchCase': 'Aa',
	'search.wholeWord': 'ab',
	'search.useRegex': '.*',
};

/** Owns the input values, options, focus and responsive layout; SearchView owns execution and results. */
export class SearchWidget extends Disposable {
	public readonly domNode: HTMLElement;
	public readonly searchInput: ContextScopedFindInput<true>;
	public readonly replaceInput: ContextScopedReplaceInput<true>;
	private readonly replaceRow: HTMLElement;
	private readonly replaceToggle: Button;
	private readonly queryOptions: ActionBar;
	private readonly replaceActions: ActionBar;
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly submitted = this._register(new Emitter<void>());
	public readonly onSearchSubmit = this.submitted.event;
	private readonly replaced = this._register(new Emitter<void>());
	public readonly onReplaceAll = this.replaced.event;
	public matchCase = false;
	public wholeWord = false;
	public useRegex = false;
	public preserveCase = false;
	private canReplace = false;

	constructor(
		container: HTMLElement,
		@IInstantiationService instantiation: IInstantiationService,
		@ISearchHistoryService history: ISearchHistoryService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-search-widget';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		const queryRow = h(document, 'div');
		queryRow.className = 'ash-search-query-row';
		const queryField = h(document, 'div');
		queryField.className = 'ash-search-query-field';
		this.replaceToggle = this._register(new Button(queryRow, {
			label: localize('search.toggleReplace', 'Toggle Replace'),
			title: localize('search.toggleReplace', 'Toggle Replace'),
			icon: Lxicon.chevronRight,
			iconOnly: true,
			size: 'small',
			onClick: () => this.setReplaceExpanded(this.replaceRow.hidden),
		}));
		queryRow.append(queryField);
		// History scopes capture their DOM parent at construction, before later focus events.
		this.domNode.append(queryRow);
		this.searchInput = this._register(instantiation.createInstance(ContextScopedFindInput<true>, queryField, {
			label: localize('search.queryLabel', 'Search workspace'),
			placeholder: localize('search.query', 'Search'),
			presentation: 'compact',
			flexibleHeight: true,
			flexibleMaxHeight: 134,
			history: new Set(history.load().search),
		}));
		this.queryOptions = this._register(new ActionBar(queryField, {
			ariaLabel: localize('search.options', 'Search options'),
			highlightToggledItems: true,
			actionViewItemProvider: action => new LabelActionViewItem(action, {
				label: queryOptionLabels[action.id] ?? action.label,
				ariaLabel: action.label,
			}),
		}));
		this.queryOptions.element.classList.add('ash-search-query-options');
		this.replaceRow = h(document, 'div');
		this.replaceRow.className = 'ash-search-replace-row';
		this.replaceRow.id = `ash-search-replace-${this.searchInput.inputBox.inputElement.id}`;
		this.replaceToggle.domNode.setAttribute('aria-controls', this.replaceRow.id);
		const replaceField = h(document, 'div');
		replaceField.className = 'ash-search-replace-field';
		this.replaceRow.append(replaceField);
		this.domNode.append(this.replaceRow);
		this.replaceInput = this._register(instantiation.createInstance(ContextScopedReplaceInput<true>, replaceField, {
			label: localize('search.replace', 'Replace'),
			presentation: 'compact',
			flexibleHeight: true,
			flexibleMaxHeight: 134,
			history: new Set(history.load().replace),
		}));
		this.replaceActions = this._register(new ActionBar(replaceField, {
			ariaLabel: localize('search.replaceActions', 'Replacement actions'),
			highlightToggledItems: true,
			actionViewItemProvider: action => new LabelActionViewItem(action, { label: action.id === 'search.preserveCase' ? 'AB' : '', ariaLabel: action.label }),
		}));
		this.setReplaceExpanded(true);
		for (const input of [this.searchInput, this.replaceInput]) {
			this._register(input.inputBox.onDidChange(() => this.changed.fire()));
			this._register(input.inputBox.onKeyDown(event => {
				if (event.key === 'Enter' && !event.isComposing && !event.shiftKey && !event.altKey && input === this.searchInput) {
					event.preventDefault();
					event.stopPropagation();
					this.submitted.fire();
				}
			}));
		}
		this._register(history.onDidClearHistory(() => {
			this.searchInput.inputBox.clearHistory();
			this.replaceInput.inputBox.clearHistory();
		}));
		this.updateOptions();
		const targetWindow = document.defaultView!;
		if (targetWindow.ResizeObserver) {
			const scheduled = this._register(new MutableDisposable());
			// Responsive classes can resize the observed widget; apply them in the next frame.
			const observer = new targetWindow.ResizeObserver(() => {
				if (!scheduled.value) {
					scheduled.value = scheduleAtNextAnimationFrame(targetWindow, () => { scheduled.clear(); this.layout(); });
				}
			});
			observer.observe(this.domNode);
			this._register(toDisposable(() => observer.disconnect()));
		}
	}

	public layout(): void {
		const narrow = this.domNode.clientWidth < 260;
		this.domNode.classList.toggle('ash-search-widget-narrow', narrow);
		this.searchInput.inputBox.layout();
		this.replaceInput.inputBox.layout();
	}

	public setReplaceExpanded(expanded: boolean): void {
		if (!expanded && this.replaceRow.contains(this.domNode.ownerDocument.activeElement)) {
			this.focus();
		}
		this.replaceRow.hidden = !expanded;
		this.replaceRow.classList.toggle('expanded', expanded);
		this.replaceToggle.domNode.setAttribute('aria-expanded', String(expanded));
		this.replaceToggle.domNode.classList.toggle('expanded', expanded);
		this.replaceInput.inputBox.layout();
	}

	public focus(): void {
		this.searchInput.inputBox.focus();
	}

	public setReplaceEnabled(enabled: boolean): void {
		if (enabled === this.canReplace) { return; }
		this.canReplace = enabled;
		this.updateOptions();
	}

	public setQueryOptions(matchCase: boolean, useRegex: boolean): void {
		this.matchCase = matchCase;
		this.useRegex = useRegex;
		this.updateOptions();
	}

	private updateOptions(): void {
		this.queryOptions.setActions([
			{
				id: 'search.matchCase',
				label: localize('search.matchCase', 'Match Case'),
				tooltip: localize('search.matchCase', 'Match Case'),
				enabled: true,
				checked: this.matchCase,
				run: () => {
					this.matchCase = !this.matchCase;
					this.updateOptions();
					this.changed.fire();
				},
			},
			{
				id: 'search.wholeWord',
				label: localize('search.wholeWord', 'Match Whole Word'),
				tooltip: localize('search.wholeWord', 'Match Whole Word'),
				enabled: true,
				checked: this.wholeWord,
				run: () => {
					this.wholeWord = !this.wholeWord;
					this.updateOptions();
					this.changed.fire();
				},
			},
			{
				id: 'search.useRegex',
				label: localize('search.useRegex', 'Use Regular Expression'),
				tooltip: localize('search.useRegex', 'Use Regular Expression'),
				enabled: true,
				checked: this.useRegex,
				run: () => {
					this.useRegex = !this.useRegex;
					this.updateOptions();
					this.changed.fire();
				},
			},
		]);
		this.replaceActions.setActions([
			{
				id: 'search.preserveCase',
				label: localize('search.preserveCase', 'Preserve Case'),
				tooltip: localize('search.preserveCase', 'Preserve Case'),
				enabled: true,
				checked: this.preserveCase,
				run: () => {
					this.preserveCase = !this.preserveCase;
					this.updateOptions();
					this.changed.fire();
				},
			},
			{
				id: 'search.replaceAll',
				label: localize('search.replaceAll', 'Replace All'),
				tooltip: localize('search.replaceAll', 'Replace All'),
				icon: Lxicon.edit,
				enabled: this.canReplace,
				run: () => this.replaced.fire(),
			},
		]);
	}
}
