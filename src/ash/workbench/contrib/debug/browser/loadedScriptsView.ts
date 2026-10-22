import { getHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { h, addDisposableListener } from '../../../../base/browser/dom.js';
import { DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { defaultInputBoxStyles, defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { localize } from '../../../../nls.js';
import { IDebugService, type IDebugSource, type IDebugSession } from '../common/debug.js';
import { getUriFromSource } from '../common/debugSource.js';

/** A view-owned projection of loaded source catalogs; adapters remain their authority. */
export class LoadedScriptsView extends ViewPane {
	private readonly sessions = this._register(new DisposableMap<string, DisposableStore>());
	private readonly rows = this._register(new DisposableStore());
	private readonly search: InputBox;
	private readonly list: HTMLUListElement;
	private entries: readonly { session: IDebugSession; source: IDebugSource; }[] = [];
	private generation = 0;

	constructor(
		container: HTMLElement,
		options: IViewPaneOptions,
		@IDebugService private readonly debug: IDebugService,
		@IEditorService private readonly editors: IEditorService,
		@IUriIdentityService private readonly identity: IUriIdentityService,
		@ILogService private readonly log: ILogService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super(container, { minimumBodySize: 72, ...options });
		this.element.classList.add('ash-debug-section');
		this.contentElement.classList.add('ash-debug-section-content');
		this.search = this._register(
			new InputBox(this.contentElement, {
				inputBoxStyles: defaultInputBoxStyles,
				ariaLabel: localize('debug.loadedSourceFilter', 'Filter loaded sources'),
			}),
		);
		this._register(this.search.onDidChange(() => this.render()));
		const refresh = this._register(
			new Button(this.headerActionsElement, {
				...defaultButtonStyles,
				label: localize('debug.loadedSourceRefresh', 'Refresh loaded sources'),
				size: 'small',
			}),
		);
		this._register(refresh.onDidClick(() => this.refresh()));
		this.list = h(container.ownerDocument, 'ul');
		this.list.className = 'ash-debug-list';
		this.list.setAttribute('aria-label', localize('debug.loadedSources', 'Loaded Scripts'));
		this.contentElement.append(this.list);
		this._register(debug.onDidChangeSession(() => this.refresh()));
		this.refresh();
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible) this.refresh();
		else ++this.generation;
	}

	private refresh(): void {
		const generation = ++this.generation;
		const current = new Set(this.debug.sessions.map((session) => session.id));
		for (const id of this.sessions.keys()) if (!current.has(id)) this.sessions.deleteAndDispose(id);
		if (!this.isVisible()) return;
		for (const session of this.debug.sessions)
			if (!this.sessions.has(session.id)) {
				const store = this.sessions.set(session.id, new DisposableStore());
				store.add(session.onDidLoadedSource(() => this.refresh()));
			}
		void Promise.all(
			this.debug.sessions
				.filter((session) => session.capabilities.supportsLoadedSourcesRequest)
				.map(async (session) => {
					try {
						return { session, sources: await session.loadedSources() };
					} catch (error) {
						if (!this.isDisposed && generation === this.generation)
							this.notifications.error(error instanceof Error ? error : String(error));
						return { session, sources: [] };
					}
				}),
		).then(
			(catalogs) => {
				if (this.isDisposed || generation !== this.generation) return;
				this.entries = catalogs.flatMap(({ session, sources }) =>
					this.debug.getSession(session.id) === session ? sources.map((source) => ({ session, source })) : [],
				);
				this.render();
			},
			(error) => {
				if (!this.isDisposed && generation === this.generation) this.notifications.error(error);
			},
		);
	}

	private render(): void {
		this.rows.clear();
		const filter = this.search.value.toLocaleLowerCase();
		this.list.replaceChildren(
			...this.entries
				.filter(({ source }) =>
					`${source.name ?? ''} ${source.path ?? ''}`.toLocaleLowerCase().includes(filter),
				)
				.map(({ session, source }) => {
					const item = h(this.element.ownerDocument, 'li');
					const button = h(this.element.ownerDocument, 'button');
					button.type = 'button';
					button.className = 'ash-debug-frame';
					button.textContent = `${source.name ?? source.path ?? localize('debug.repl.source', 'Source')} — ${session.name}`;
					this.rows.add(
						getHoverDelegate().setupHover({ target: button, content: source.path ?? button.textContent }),
					);
					this.rows.add(
						addDisposableListener(button, 'click', () => {
							if (this.debug.getSession(session.id) !== session) return;
							const resource = getUriFromSource(source, source.path, session.id, this.identity, this.log);
							void this.editors
								.openEditor(
									{
										resource,
										label: source.name,
										readOnly: resource.scheme === 'debug',
										...(resource.scheme === 'debug' ? { contentType: 'text/plain' } : {}),
									},
									{ pinned: true },
								)
								.catch((error) => {
									if (!this.isDisposed) this.notifications.error(error);
								});
						}),
					);
					item.append(button);
					return item;
				}),
		);
	}
}
