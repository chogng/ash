import './sessionBrowserTabs.css';
import { h } from '../../../../base/browser/dom.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnchorAlignment, ContextViewFocusRestore } from '../../../../base/browser/ui/contextview/contextview.js';
import { Menu } from '../../../../base/browser/ui/menu/menu.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import { Emitter } from '../../../../base/common/event.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import type { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import type { INotificationService } from '../../../../platform/notification/common/notification.js';
import { defaultButtonStyles, defaultMenuStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import type { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import type { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import type { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import type { ISessionsEntryService } from '../../../services/layout/common/sessionsEntryService.js';

/** Supplies the trigger as the command context; the toolbar still owns execution and navigation. */
export class SessionBrowserTabsActionViewItem extends ButtonActionViewItem {
	private readonly visibility = this._register(new Emitter<boolean>());
	readonly onDidChangeDropdownVisibility = this.visibility.event;

	override render(container: HTMLElement): void {
		super.render(container);
		this.button.domNode.setAttribute('aria-haspopup', 'menu');
		this.button.domNode.setAttribute('aria-expanded', 'false');
	}

	protected override async runAction(): Promise<void> {
		this.button.domNode.setAttribute('aria-expanded', 'true');
		this.visibility.fire(true);
		try { await this.runActionWithContext(this.action, this.button.domNode); }
		finally {
			if (!this.isDisposed) {
				this.button.domNode.setAttribute('aria-expanded', 'false');
				this.visibility.fire(false);
			}
		}
	}
}

const openMenus = new WeakMap<HTMLElement, () => void>();

/** Projects the retained browser inputs into an action menu without resolving or copying page models. */
export async function showSessionBrowserTabs(
	anchor: HTMLElement | undefined,
	entries: ISessionsEntryService,
	browsers: IBrowserViewWorkbenchService,
	editors: IEditorService,
	editorPart: IEditorPart,
	contextViews: IContextViewService,
	notifications: INotificationService,
): Promise<void> {
	const trigger = anchor ?? contextViews.container;
	const dismiss = openMenus.get(trigger);
	if (dismiss) { dismiss(); return; }
	const source = entries.conversationBrowserContext.get();
	if (source === undefined) return;
	const isCurrent = (): boolean => entries.conversationBrowserContext.get() === source;
	using lifetime = new DisposableStore();
	using labels = new DisposableStore();
	const hide = (): void => { if (menu.getContainer().isConnected) contextViews.hide(); };
	openMenus.set(trigger, hide);
	lifetime.add(toDisposable(() => { if (openMenus.get(trigger) === hide) openMenus.delete(trigger); }));
	const reportError = (error: unknown): void => { if (!isCancellationError(error)) notifications.error(String(error)); };
	const closeLabel = localize('sessions.browser.closeTab', 'Close tab');
	const maximizeLabel = localize('sessions.browser.maximizeTab', 'Maximize tab');
	let request: { readonly input?: BrowserEditorInput; readonly maximized: boolean; } | undefined;
	const choose = (input: BrowserEditorInput | undefined, maximized: boolean): void => {
		if (!isCurrent()) return;
		request = { input, maximized };
		hide();
	};
	let inlineActions = new Map<string, readonly IAction[]>();
	const host = h(trigger.ownerDocument, 'div');
	const menu = lifetime.add(new Menu(host, [], {
		ariaLabel: localize('sessions.browser.tabs', 'Browser tabs'),
		className: 'ash-session-browser-tabs-menu',
		iconPlacement: 'leading',
		buttonStyles: defaultButtonStyles,
		getIcon: action => entries.conversationEditors.find(input => input instanceof BrowserEditorInput && input.id === action.id)?.getIcon?.() ?? action.icon,
		getTooltip: action => action.tooltip,
		getInlineActions: action => inlineActions.get(action.id),
	}, defaultMenuStyles));
	const newTab: IAction = {
		id: 'new', label: localize('sessions.browser.newTab', 'New tab'), tooltip: '', icon: Lxicon.add, enabled: true,
		run: () => choose(undefined, false),
	};
	let rendered = '';
	const render = (): void => {
		const tabs = entries.conversationEditors.filter((input): input is BrowserEditorInput => input instanceof BrowserEditorInput && !input.isDisposed);
		const signature = JSON.stringify(tabs.map(input => [input.id, input.getName(), input.url, input.getIcon()]));
		if (signature === rendered) return;
		rendered = signature;
		inlineActions = new Map(tabs.map(input => [input.id, [
			{
				id: input.id + '.close', label: closeLabel, tooltip: closeLabel, icon: Lxicon.close, enabled: true,
				run: () => entries.closeConversationEditor(input).catch(reportError)
			},
			{
				id: input.id + '.maximize', label: maximizeLabel, tooltip: maximizeLabel, icon: Lxicon.maximize, enabled: true,
				run: () => choose(input, true)
			},
		]]));
		const actions: IAction[] = tabs.map(input => ({
			id: input.id, label: input.getName(), labelDescription: input.url, tooltip: input.getTitle(),
			enabled: true, run: () => choose(input, false),
		}));
		menu.setActions([...actions, ...(tabs.length ? [new Separator()] : []), newTab]);
	};
	const refresh = (): void => {
		labels.clear();
		for (const input of entries.conversationEditors) {
			if (input.onDidChangeLabel) labels.add(input.onDidChangeLabel(render));
		}
		render();
	};
	await new Promise<void>(resolve => {
		lifetime.add(editorPart.onDidChangeEditors(refresh));
		lifetime.add(menu.onDidCancel(hide));
		refresh();
		const shown = contextViews.show({
			anchor: trigger, content: menu.getContainer(), presentation: 'menu', gap: 4,
			anchorAlignment: AnchorAlignment.Right, focusRestore: ContextViewFocusRestore.Previous,
			blockOutsidePointer: true, onHide: () => resolve(),
		});
		if (!shown) { resolve(); return; }
		menu.focus(trigger.matches(':focus-visible'));
		lifetime.add(autorun(reader => { if (entries.conversationBrowserContext.read(reader) !== source) hide(); }));
	});
	if (!request || !isCurrent()) return;
	const { input, maximized } = request;
	try {
		await entries.openConversationBrowser(async target => {
			if (!isCurrent()) return;
			if (input) {
				if (input.isDisposed || !entries.conversationEditors.includes(input)) return;
				await editors.openEditor(input, { pinned: true }, target);
			} else {
				await browsers.createBrowserView({ initialUrl: 'about:blank', owner: { type: 'user' } }, undefined, { target });
			}
		});
		if (maximized && isCurrent()) await entries.setConversationVisible(false);
	} catch (error) { reportError(error); }
}
