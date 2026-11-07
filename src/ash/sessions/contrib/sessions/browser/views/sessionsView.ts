import '../media/sessionsViewPane.css';
import { getWindow, h } from '../../../../../base/browser/dom.js';
import { autorun } from '../../../../../base/common/observable.js';
import { observeResize } from '../../../../../base/browser/observer.js';
import { AnimationFrameScheduler } from '../../../../../base/browser/scheduler.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ViewPane, type IViewPaneOptions } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { SessionsViewRegistry } from '../../../../common/views.js';
import { localize } from '../../../../../nls.js';
import { ViewContainerLocation } from '../../../../../workbench/common/views.js';
import { SessionsList, type SessionsListPresentation } from './sessionsList.js';
import type { SessionsCatalogAccessibility, SessionsCatalogListInput } from './sessionsCatalogList.js';
import { CHAT_WORKSPACE_NAVIGATION_ID } from '../../../chat/common/constants.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';

export const SESSIONS_NAVIGATION_CONTAINER_ID = 'sessions.navigation.chats';
export const CODE_NAVIGATION_CONTAINER_ID = 'sessions.navigation.code';

export function registerSessionsNavigation(): IDisposable {
	const hasChatCatalog = SessionsViewRegistry.getViewContainers(ViewContainerLocation.Sidebar).some(container => container.id === CHAT_WORKSPACE_NAVIGATION_ID);
	const registrations = new DisposableStore();
	for (const [id, title, key, ctorDescriptor] of [
		[SESSIONS_NAVIGATION_CONTAINER_ID, localize('sessions.activity.chat', 'Chat'), 'sessions.activity.chat', new SyncDescriptor(SessionsView, ['chat'])],
		[CODE_NAVIGATION_CONTAINER_ID, localize({ bundle: 'ash', key: 'sessions.mode.code' }, 'Code'), 'sessions.mode.code', new SyncDescriptor(SessionsView, ['code'])],
	] as const) {
		if (id === SESSIONS_NAVIGATION_CONTAINER_ID && hasChatCatalog) continue;
		registrations.add(SessionsViewRegistry.registerViewContainer({ id, title, localizationKey: { bundle: 'ash', key }, location: ViewContainerLocation.Sidebar, order: 0 }));
		registrations.add(SessionsViewRegistry.registerViews(id, [{ id: id + '.view', title, localizationKey: { bundle: 'ash', key }, ctorDescriptor, canToggleVisibility: false }]));
	}
	return registrations;
}

export interface SessionsCatalogListModel extends SessionsCatalogListInput, IDisposable {
	attach(window: Window & typeof globalThis, isVisible: () => boolean): void;
}

interface SessionsCatalogPresentation {
	readonly input: SyncDescriptor<SessionsCatalogListModel>;
	readonly accessibility: SessionsCatalogAccessibility;
}

export class SessionsView extends ViewPane {
	private list?: SessionsList;
	private hiddenListState: ReturnType<SessionsList['getViewState']> | undefined;
	private readonly embedded: boolean;
	private readonly restoreListState?: AnimationFrameScheduler;
	constructor(presentation: SessionsListPresentation | SessionsCatalogPresentation, parent: HTMLElement, options: IViewPaneOptions, @IInstantiationService instantiation: IInstantiationService) {
		const embedded = typeof presentation !== 'string' && 'openCommand' in presentation;
		super(parent, embedded ? { ...options, headerSize: 32, minimumBodySize: 0 } : options);
		this.embedded = embedded;
		this.contentElement.classList.add('ash-sessions-navigation-view');
		this.contentElement.classList.toggle('embedded', embedded);
		if (typeof presentation !== 'string' && 'input' in presentation) {
			const input = this._register(instantiation.createInstance(presentation.input));
			input.attach(getWindow(this.element), () => this.isBodyVisible());
			presentation = { catalog: input, accessibility: presentation.accessibility };
		}
		const title = localize({ bundle: 'ash.sessions', key: 'sessions.list.header' }, 'Sessions');
		const lists = SessionsList.instantiateObservable(instantiation, this._store, h(this.contentElement.ownerDocument, 'div'), title, presentation);
		this.list = lists.get();
		this.contentElement.append(this.list.element);
		const loading = this._register(new MutableDisposable());
		const loadingListener = this._register(new MutableDisposable());
		const watchLoading = (list: SessionsList): void => {
			loadingListener.value = autorun(reader => {
				if (list.loading.read(reader)) {
					if (!loading.value) {
						const progress = this.getProgressIndicator().show(true, 150);
						loading.value = toDisposable(() => progress.done());
					}
				} else {
					loading.clear();
				}
			});
		};
		watchLoading(this.list);
		this._register(lists.onDidChange(watchLoading));
		this.restoreListState = this._register(new AnimationFrameScheduler(getWindow(this.element), () => {
			const state = this.hiddenListState;
			if (!state || !this.isVisible()) return;
			this.hiddenListState = undefined;
			this.list?.restoreViewState(state);
		}));
		const sizeObserver = this._register(new MutableDisposable());
		if (embedded) {
			const measure = this._register(new AnimationFrameScheduler(getWindow(this.element), () => {
				if (this.list?.element.isConnected) this.minimumBodySize = this.list.element.offsetHeight;
			}));
			const observeList = (list: SessionsList): void => {
				sizeObserver.value = observeResize(list.element, () => measure.schedule());
				measure.schedule();
			};
			observeList(this.list);
			this._register(lists.onDidChange(observeList));
			this._register(this.onDidChangeBodyVisibility(visible => { if (visible) measure.schedule(); }));
		}
		this._register(lists.onDidChange(list => {
			const previous = this.list!;
			const state = this.hiddenListState ?? previous.getViewState();
			previous.element.replaceWith(list.element);
			this.list = list;
			this.hiddenListState = state;
			if (this.isVisible()) { this.restoreListState?.schedule(); }
		}));
	}
	public override get maximumSize(): number { return this.embedded ? this.minimumSize : super.maximumSize; }
	public override setVisible(visible: boolean): void {
		if (!this.list) {
			super.setVisible(visible);
			return;
		}
		if (!visible && this.isVisible()) {
			this.restoreListState?.cancel();
			this.hiddenListState ??= this.list.getViewState();
		}
		super.setVisible(visible);
		// Retain the view model while only the current mode contributes sidebar rows and tab stops.
		if (visible) this.contentElement.append(this.list.element);
		else {
			this.list.closeIconPickers();
			this.list.element.remove();
		}
		if (visible && this.hiddenListState) {
			this.hiddenListState = { ...this.hiddenListState, focus: undefined };
			// The sidebar host completes its mode switch and layout after mounting the pane.
			this.restoreListState?.schedule();
		}
	}
	public focus(): void { this.list?.focus(); }
}
