import { Disposable } from '../../base/common/lifecycle.js';
import { autorun } from '../../base/common/observable.js';
import { extUri } from '../../base/common/resources.js';
import { IInstantiationService } from '../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IEditorPart } from '../../workbench/browser/parts/editor/editorPart.js';
import { EditorPaneVisibility } from '../../workbench/browser/parts/editor/editorPane.js';
import { ViewContainerLocation } from '../../workbench/common/views.js';
import { IEditorService, type EditorInput } from '../../workbench/services/editor/common/editorService.js';
import { ISessionsPageService, type ISessionsPageDescriptor } from '../common/pages.js';
import { ISessionsService } from '../services/sessions/browser/sessionsService.js';
import { SessionsPageRegistry } from './pages.js';
import type { AuxiliaryBarPart } from './parts/auxiliarybar/auxiliaryBarPart.js';
import type { SessionsPart } from './parts/sessionsPart.js';
import type { SidebarPart } from './parts/sidebarPart.js';
import type { SessionsWorkbenchLayout } from './workbench.js';

/** Applies the registered page composition while retaining the Parts and their models. */
export class SessionsPageLayoutController extends Disposable {
	private applying = false;
	private openingEditor = false;
	private sessionEditor: EditorInput | undefined;
	private readonly auxiliaryContainers = new Map<string, string>();

	constructor(
		private readonly sidebar: SidebarPart,
		private readonly sessionsPart: SessionsPart,
		private readonly auxiliarybar: AuxiliaryBarPart,
		@ISessionsPageService private readonly pages: ISessionsPageService,
		@ISessionsService private readonly sessions: ISessionsService,
		@ILayoutService private readonly layout: SessionsWorkbenchLayout,
		@IEditorPart private readonly editor: IEditorPart,
		@IEditorService private readonly editors: IEditorService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
	}

	public start(): void {
		this._register(autorun(reader => this.applyPage(this.pages.getPage(this.pages.activePage.read(reader)))));
		this._register(this.editors.onDidActiveEditorChange(() => {
			const input = this.editors.activeEditor;
			const editorPage = this.getEditorPage(input);
			if (input && !editorPage) {
				this.sessionEditor = input;
			} else if (this.sessionEditor && !this.editor.groups.some(group => group.inputs.includes(this.sessionEditor!))) {
				this.sessionEditor = undefined;
			}
			const current = this.pages.getPage(this.pages.activePage.get());
			if (this.applying || this.openingEditor || !input || current.layout.editor === 'hidden') {
				return;
			}
			const target = editorPage ?? this.pages.pages.get().find(page => page.layout.editor === 'session');
			if (target) {
				this.pages.openPage(target.id);
			}
		}));
		this._register(this.auxiliarybar.onDidSelectComposite(event => {
			this.openContainerPage(event.compositeId, ViewContainerLocation.AuxiliaryBar);
			const page = this.pages.getPage(this.pages.activePage.get());
			if (page.layout.auxiliaryBar === 'session') {
				this.auxiliaryContainers.set(page.id, event.compositeId);
			}
		}));
		this._register(this.layout.onDidChangePartVisibility(event => {
			if (event.partId !== 'editor') {
				return;
			}
			// Replacement editors remain mounted, and must suspend rendering while their Part is hidden.
			const visibility = event.visible ? EditorPaneVisibility.Visible : EditorPaneVisibility.Hidden;
			for (const group of this.editor.groups) {
				if (this.getEditorPage(group.activeInput)) {
					group.activePane!.setVisible(visibility);
				}
			}
		}));
	}

	public openContainerPage(containerId: string, location: ViewContainerLocation): void {
		const pages = this.pages.pages.get();
		const owner = pages.find(page => {
			const target = location === ViewContainerLocation.Sidebar ? page.layout.sidebar : page.layout.auxiliaryBar;
			return typeof target === 'object' && target.containerId === containerId;
		}) ?? pages.find(page => location === ViewContainerLocation.Panel ? page.layout.panel : page.layout.auxiliaryBar === 'session');
		if (!owner) {
			throw new Error(`No Sessions page hosts view container: ${containerId}`);
		}
		this.pages.openPage(owner.id);
	}

	private applyPage(page: ISessionsPageDescriptor): void {
		this.applying = true;
		try {
			this.layout.updateParts(() => {
				if (page.layout.conversation) {
					this.sessions.selectPage(page.layout.conversation);
				}
				this.sessionsPart.setPage(page.layout.conversation ?? page.id);
				this.sidebar.setEmptyPage(page.layout.sidebar === 'hidden');
				if (page.layout.sidebar === 'sessions' && this.sidebar.currentView === 'views') {
					this.sidebar.selectView('chats');
				}
				this.layout.setPartAvailable('sidebar', page.layout.sidebar !== 'hidden');
				this.layout.setPartAvailable('auxiliarybar', page.layout.auxiliaryBar !== 'hidden');
				this.layout.setPartAvailable('panel', page.layout.panel);
				if (page.layout.primary === 'editor') {
					// Establish the flexible center before hiding Sessions, preserving side-panel widths.
					this.layout.setPartAvailable('editor', true);
					this.layout.showPart('editor');
				}
				this.layout.setPartAvailable('sessions', page.layout.primary === 'sessions');
				if (typeof page.layout.sidebar === 'object') {
					this.sidebar.showComposite(page.layout.sidebar.containerId);
				}
				const registered = this.pages.pages.get();
				const auxiliaryId = this.auxiliarybar.activeCompositeId;
				const pageContainer = registered.some(item => typeof item.layout.auxiliaryBar === 'object' && item.layout.auxiliaryBar.containerId === auxiliaryId);
				const sessionToolsPage = registered.find(item => item.layout.auxiliaryBar === 'session');
				if (auxiliaryId && !pageContainer && sessionToolsPage) {
					this.auxiliaryContainers.set(sessionToolsPage.id, auxiliaryId);
				}
				if (typeof page.layout.auxiliaryBar === 'object') {
					this.auxiliarybar.showComposite(page.layout.auxiliaryBar.containerId);
				} else if (page.layout.auxiliaryBar === 'session') {
					const saved = this.auxiliaryContainers.get(page.id);
					if (saved) {
						this.auxiliarybar.showComposite(saved);
					}
				}
				const replacementEditor = this.getEditorPage(this.editor.activeInput);
				if (page.layout.editor === 'session' && replacementEditor && this.sessionEditor) {
					this.editor.activateEditor(this.sessionEditor);
				}
				const isReplacementActive = this.getEditorPage(this.editor.activeInput) !== undefined;
				this.layout.setPartAvailable('editor', typeof page.layout.editor === 'object' || (page.layout.editor === 'session' && !isReplacementActive));
			});
		} finally {
			this.applying = false;
		}
		if (typeof page.layout.editor === 'object' && !this.openingEditor && !extUri.isEqual(this.editor.activeInput?.resource, page.layout.editor.resource)) {
			void this.openPageEditor(page.id);
		}
	}

	private getEditorPage(input: EditorInput | undefined): ISessionsPageDescriptor | undefined {
		return this.pages.pages.get().find(page => typeof page.layout.editor === 'object' && extUri.isEqual(page.layout.editor.resource, input?.resource));
	}

	private async openPageEditor(pageId: string): Promise<void> {
		this.openingEditor = true;
		try {
			const contribution = SessionsPageRegistry.getPages().get(pageId)!;
			const input = this.instantiation.invokeFunction(contribution.getEditorInput!);
			await this.editors.openEditor(input, { pinned: true, preserveFocus: true });
		} catch (error) {
			this.notifications.error(String(error));
			return;
		} finally {
			this.openingEditor = false;
		}
		if (this.isDisposed) {
			return;
		}
		this.applyPage(this.pages.getPage(this.pages.activePage.get()));
		if (this.pages.activePage.get() === pageId) {
			this.editor.focus();
		}
	}
}
