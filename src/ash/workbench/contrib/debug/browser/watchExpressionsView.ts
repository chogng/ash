import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { getHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDebugService, type IDebugSession, type IDebugEvaluateResult } from '../common/debug.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { DebugWatchAccessibilityAnnouncer } from '../common/debugAccessibilityAnnouncer.js';
interface DebugWatchResult { readonly expression: string; readonly result?: IDebugEvaluateResult; readonly error?: string; }

/** Watch owns drafts and evaluation results; durable definitions remain in Rust. */
export class WatchExpressionsView extends ViewPane {
	private readonly loadingProgress = this._register(new MutableDisposable());
	private readonly watchElement: HTMLUListElement;
	private readonly watchForm: HTMLFormElement;
	private readonly watchInput: HTMLInputElement;
	private readonly addWatchButton: Button;
	private readonly watchToolbar: WorkbenchToolBar;
	private readonly rowControls = this._register(new DisposableStore());
	private watchResults: readonly DebugWatchResult[] = [];
	private refreshGeneration = 0;
	private readonly announcements: DebugWatchAccessibilityAnnouncer;
	constructor(container: HTMLElement, options: IViewPaneOptions,
		@IDebugService private readonly debug: IDebugService,
		@IContextMenuService contextMenus: IContextMenuService,
		@INotificationService private readonly notifications: INotificationService,
		@IInstantiationService instantiation: IInstantiationService) {
		super(container, { minimumBodySize: 32, ...options });
		this.announcements = instantiation.createInstance(DebugWatchAccessibilityAnnouncer);
		const document = container.ownerDocument;
		this.element.classList.add('ash-debug-section');
		this.contentElement.classList.add('ash-debug-section-content');
		this.watchElement = h(document, 'ul');
		this.watchElement.className = 'ash-debug-list ash-debug-watch';
		this.watchElement.setAttribute('aria-label', localize('debug.watch', 'Watch'));
		this.contentElement.append(this.watchElement);
		this.watchForm = h(document, "form");
		this.watchForm.className = "ash-debug-input-form empty";
		this.watchForm.hidden = true;
		this.watchInput = h(document, "input");
		this.watchInput.type = "text";
		this.watchForm.append(this.watchInput);
		this.addWatchButton = this._register(new Button(this.watchForm, {
			...defaultButtonStyles,
			label: localize("debug.addWatch", "Add watch expression"),
			icon: Lxicon.add,
			iconOnly: true,
			type: "submit",
			title: localize("debug.addWatch", "Add watch expression"),
		}));
		this.contentElement.prepend(this.watchForm);
		this.watchToolbar = this._register(new WorkbenchToolBar(this.headerActionsElement, contextMenus, { ariaLabel: localize("debug.watch", "Watch") }));
		const addWatchLabel = localize("debug.addWatch", "Add watch expression");
		const removeAllWatchesLabel = localize("debug.removeAllWatches", "Remove All Expressions");
		this.watchToolbar.setActions([
			{
				id: "debug.addWatch",
				label: addWatchLabel,
				tooltip: addWatchLabel,
				enabled: true,
				icon: Lxicon.add,
				run: () => {
					this.setCollapsed(false);
					this.watchForm.hidden = false;
					this.watchForm.classList.remove("empty");
					this.watchInput.focus();
				},
			},
			{
				id: "debug.removeAllWatches",
				label: removeAllWatchesLabel,
				tooltip: removeAllWatchesLabel,
				enabled: true,
				icon: Lxicon.close,
				run: () => {
					for (const expression of this.debug.watchExpressions) {
						this.debug.removeWatchExpression(expression);
					}
				},
			},
		]);
		this._register(addDisposableListener(this.watchInput, "keydown", event => {
			if (event.key === "Escape" && !event.isComposing) {
				event.preventDefault();
				this.watchInput.value = "";
				this.watchForm.hidden = true;
				this.watchForm.classList.add("empty");
				this.watchToolbar.focus();
			}
		}));

		this._register(addDisposableListener(this.watchElement, 'click', event => this.removeWatch(event)));
		this._register(addDisposableListener(this.watchForm, 'submit', event => this.addWatch(event)));
		this._register(debug.onDidChangeWatchExpressions(() => this.refresh()));
		this._register(debug.onDidChangeSession(() => {
			// A stopped event first invalidates the old frame. DebugService publishes
			// the completed selection before Watch evaluates user expressions.
			++this.refreshGeneration;
			this.loadingProgress.clear();
			this.watchResults = [];
			this.render();
		}));
		this._register(debug.getViewModel().onDidFocusStackFrame(() => this.refresh()));
		this._register(debug.getViewModel().onDidFocusThread(() => this.refresh()));
		this._register(debug.getViewModel().onWillUpdateViews(() => this.refresh()));
		this.refresh();
	}
	private refresh(): void {
		this.loadingProgress.clear();
		const generation = ++this.refreshGeneration;
		this.watchResults = [];
		this.render();
		const selection = this.debug.getViewModel();
		if (this.debug.session?.state === 'stopped' && !selection.focusedStackFrame && !selection.focusedThread) return;
		void this.refreshWatches(generation).catch(error => {
			if (!this.isDisposed && generation === this.refreshGeneration) this.notifications.error(message(error));
		});
	}
	private render(): void {
		this.watchInput.setAttribute('aria-label', localize('debug.addWatch', 'Add watch expression'));
		this.watchInput.placeholder = localize('debug.watchPlaceholder', 'Expression to watch');
		this.rowControls.clear();
		this.watchElement.replaceChildren(...this.debug.watchExpressions.map((expression, index) => watchItem(this.rowControls, this.element.ownerDocument, expression, this.watchResults.find(result => result.expression === expression), index)));
	}
	private isCurrentInspection(session: IDebugSession, generation: number): boolean {
		return !this.isDisposed && generation === this.refreshGeneration && this.debug.session === session && session.state === "stopped";
	}

	private addWatch(event: Event): void {
		event.preventDefault();
		const expression = this.watchInput.value;
		this.debug.addWatchExpression(expression);
		this.watchInput.value = "";
		this.watchForm.hidden = true;
		this.watchForm.classList.add("empty");
		this.watchToolbar.focus();
	}

	private removeWatch(event: Event): void {
		const index = indexFromEvent(event, ".ash-debug-watch-remove", "watchIndex", this.element.ownerDocument);
		const expression = index === undefined ? undefined : this.debug.watchExpressions[index];
		if (expression) this.debug.removeWatchExpression(expression);
	}

	private async refreshWatches(generation: number): Promise<void> {
		const session = this.debug.session;
		const expressions = this.debug.watchExpressions;
		if (!session || session.state !== "stopped") { this.watchResults = expressions.map(expression => ({ expression })); this.render(); return; }
		const frameId = this.debug.getViewModel().focusedStackFrame?.id;
		const loading = session.evaluateWatchExpressions(expressions, frameId);
		const progress = this.getProgressIndicator().show(true, 150);
		const handle = toDisposable(() => progress.done());
		this.loadingProgress.value = handle;
		const finish = (): void => { if (this.loadingProgress.value === handle) this.loadingProgress.clear(); };
		void loading.then(finish, finish);
		const results = await loading;
		if (!this.isCurrentInspection(session, generation) || this.debug.getViewModel().focusedStackFrame?.id !== frameId || this.debug.watchExpressions !== expressions) return;
		this.watchResults = Object.freeze(results);
		this.announcements.announce(session.id, results);
		this.render();
	}


}
function watchItem(owner: DisposableStore, document: Document, expression: string, result: DebugWatchResult | undefined, index: number): HTMLLIElement {
	const item = h(document, "li");
	const value = h(document, "span");
	value.className = "ash-debug-watch-value";
	value.textContent = `${expression}${result?.result ? ` = ${result.result.result}` : result?.error ? ` — ${result.error}` : ""}`;
	owner.add(getHoverDelegate().setupHover({ target: value, content: value.textContent }));
	item.append(value);
	const remove = owner.add(new Button(item, {
		...defaultButtonStyles,
		label: localize("debug.removeWatch", "Remove watch expression"),
		icon: Lxicon.close,
		iconOnly: true,
		size: "small",
		title: localize("debug.removeWatch", "Remove watch expression"),
	})).domNode;
	remove.classList.add("ash-debug-watch-remove");
	remove.dataset.watchIndex = String(index);
	return item;
}
function indexFromEvent(event: Event, selector: string, dataName: string, document: Document): number | undefined { const target = event.target instanceof document.defaultView!.Element ? event.target.closest<HTMLElement>(selector) : null; const raw = target?.dataset[dataName]; if (raw === undefined) return undefined; const index = Number(raw); return Number.isSafeInteger(index) && index >= 0 ? index : undefined; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
