import '../media/sessionsViewPane.css';
import { getWindow, h } from '../../../../../base/browser/dom.js';
import { observeResize } from '../../../../../base/browser/observer.js';
import { AnimationFrameScheduler } from '../../../../../base/browser/scheduler.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { ViewPane, type IViewPaneOptions } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { SessionsViewRegistry } from '../../../../common/views.js';
import { localize } from '../../../../../nls.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { ViewContainerLocation } from '../../../../../workbench/common/views.js';
import { SessionsList, type SessionsListPresentation } from './sessionsList.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';

export const SESSIONS_NAVIGATION_CONTAINER_ID = 'sessions.navigation.chats';
export const CODE_NAVIGATION_CONTAINER_ID = 'sessions.navigation.code';

export function registerSessionsNavigation(): IDisposable {
	const registrations = new DisposableStore();
	for (const [id, title, key, ctorDescriptor] of [
		[SESSIONS_NAVIGATION_CONTAINER_ID, localize('sessions.activity.chat', 'Chat'), 'sessions.activity.chat', new SyncDescriptor(SessionsNavigationView, ['chat'])],
		[CODE_NAVIGATION_CONTAINER_ID, localize({ bundle: 'ash', key: 'sessions.mode.code' }, 'Code'), 'sessions.mode.code', new SyncDescriptor(SessionsNavigationView, ['code'])],
	] as const) {
		registrations.add(SessionsViewRegistry.registerViewContainer({ id, title, localizationKey: { bundle: 'ash', key }, location: ViewContainerLocation.Sidebar, order: 0 }));
		registrations.add(SessionsViewRegistry.registerViews(id, [{ id: id + '.view', title, localizationKey: { bundle: 'ash', key }, ctorDescriptor, canToggleVisibility: false }]));
	}
	return registrations;
}

export class SessionsNavigationView extends ViewPane {
	private list: SessionsList;
	private hiddenListState: ReturnType<SessionsList['getViewState']> | undefined;
	private readonly embedded: boolean;
	constructor(presentation: SessionsListPresentation, parent: HTMLElement, options: IViewPaneOptions, @ISessionsManagementService management: ISessionsManagementService, @IInstantiationService instantiation: IInstantiationService) {
		const embedded = typeof presentation !== 'string';
		super(parent, embedded ? { ...options, headerSize: 32, minimumBodySize: 0 } : options);
		this.embedded = embedded;
		this.contentElement.classList.add('ash-sessions-navigation-view');
		this.contentElement.classList.toggle('embedded', embedded);
		const loading = this._register(new MutableDisposable());
		const updateLoading = (): void => {
			if (management.state === 'loading' && management.sessions.length > 0 && !loading.value) {
				const progress = this.getProgressIndicator().show(true, 150);
				loading.value = toDisposable(() => progress.done());
			} else if (management.state !== 'loading') loading.clear();
		};
		this._register(management.onDidChange(updateLoading));
		updateLoading();
		const title = localize({ bundle: 'ash.sessions', key: 'sessions.list.header' }, 'Sessions');
		const lists = SessionsList.instantiateObservable(instantiation, this._store, h(this.contentElement.ownerDocument, 'div'), title, presentation);
		this.list = lists.get();
		this.contentElement.append(this.list.element);
		const sizeObserver = this._register(new MutableDisposable());
		if (embedded) {
			const measure = this._register(new AnimationFrameScheduler(getWindow(this.element), () => {
				if (this.list.element.isConnected) this.minimumBodySize = this.list.element.offsetHeight;
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
			const previous = this.list;
			const state = this.hiddenListState ?? previous.getViewState();
			previous.element.replaceWith(list.element);
			this.list = list;
			if (this.isVisible()) { list.restoreViewState(state); }
			else { this.hiddenListState = state; }
		}));
	}
	public override get maximumSize(): number { return this.embedded ? this.minimumSize : super.maximumSize; }
	public override setVisible(visible: boolean): void {
		if (!visible && this.isVisible()) { this.hiddenListState = this.list.getViewState(); }
		super.setVisible(visible);
		// Retain the view model while only the current mode contributes sidebar rows and tab stops.
		if (visible) this.contentElement.append(this.list.element);
		else {
			this.list.closeIconPickers();
			this.list.element.remove();
		}
		if (visible && this.hiddenListState) {
			this.list.restoreViewState({ ...this.hiddenListState, focus: undefined });
			this.hiddenListState = undefined;
		}
	}
	public focus(): void { this.list.focus(); }
}
