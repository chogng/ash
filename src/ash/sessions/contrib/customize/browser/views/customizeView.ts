import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { Icon } from '../../../../../base/common/icon.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { autorun, observableFromEvent } from '../../../../../base/common/observable.js';
import { localize } from '../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { ViewPane, type IViewPaneOptions } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { CustomizeEditorPane } from '../customizeEditor.js';

import '../media/customizeView.css';

type ResourceGroup = 'plugins' | 'skills';
interface GroupRows {
	readonly list: HTMLUListElement;
	readonly resources: DisposableStore;
	readonly buttons: Map<string, Button>;
	key: string | undefined;
}

/** Projects the retained Customize editor's catalog into the Sessions sidebar. */
export class CustomizeView extends ViewPane {
	private readonly discover: Button;

	constructor(
		parent: HTMLElement,
		options: IViewPaneOptions,
		@IEditorService editors: IEditorService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessible: IAccessibleViewService,
	) {
		super(parent, options);
		const container = this.contentElement;
		const document = container.ownerDocument;
		const title = localize('customize.title', 'Customize');
		const verbosity = AccessibilityVerbositySettingId.Customize;
		const root = h(document, 'nav', { className: 'ash-customize-navigation', attributes: { 'aria-label': title } });
		const hint = accessible.getOpenAriaHint(verbosity);
		if (hint) root.setAttribute('aria-description', hint);
		container.append(root);
		this._register(contextKeys.createScoped(root)).createKey('sessionsCustomizeSidebarFocused', true);
		const activePane = () => editors.visibleEditorPanes.find(pane => pane instanceof CustomizeEditorPane);
		const pane = observableFromEvent(this, Event.any(editors.onDidActiveEditorChange, editors.onDidVisibleEditorsChange), activePane);
		const button = (host: HTMLElement, label: string, icon: Icon | undefined, onClick: (event: MouseEvent) => void) =>
			new Button(host, { ...defaultButtonStyles, label, icon, title: label, presentation: 'quiet', onClick });

		this.discover = this._register(button(root, localize('customize.discover', 'Discover'), Lxicon.search, () => activePane()?.openSidebarCatalog('discover')));
		const groups = ([
			{ category: 'plugins', title: localize('customize.installedPlugins', 'Installed plugins'), icon: Lxicon.extensions },
			{ category: 'skills', title: localize('customize.installedSkills', 'Installed skills'), icon: Lxicon.book },
		] as const).map(group => {
			const section = h(document, 'section', { className: 'ash-customize-navigation-group' });
			const heading = h(document, 'h2');
			const headingButton = this._register(button(heading, group.title, undefined, () => activePane()?.openSidebarCatalog(group.category)));
			const list = h(document, 'ul', { attributes: { 'aria-label': group.title } });
			section.append(heading, list);
			root.append(section);
			const rows: GroupRows = { list, resources: this._register(new DisposableStore()), buttons: new Map(), key: undefined };
			return { ...group, headingButton, rows };
		});
		const connections = this._register(button(root, localize('customize.connections', 'Connections'), Lxicon.plug, () => activePane()?.openSidebarCatalog('connectors')));
		connections.domNode.classList.add('ash-customize-navigation-connections');
		this._register(autorun(reader => {
			const state = pane.read(reader)?.navigation.read(reader);
			this.discover.enabled = connections.enabled = !!state;
			this.setCurrent(this.discover, state?.current === 'discover');
			this.setCurrent(connections, state?.current === 'connectors');
			for (const { category, headingButton, rows, icon } of groups) {
				headingButton.enabled = !!state;
				this.setCurrent(headingButton, state?.current === category && !state.selected);
				this.renderRows(rows, category, state?.[category] ?? [], icon, activePane);
				for (const [id, row] of rows.buttons) {
					this.setCurrent(row, state?.selected?.category === category && state.selected.id === id);
				}
			}
		}));
		this._register(addDisposableListener(root, 'keydown', event => {
			if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
			const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
			const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
			if (index < 0) return;
			const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
				: event.key === 'ArrowUp' ? Math.max(0, index - 1) : Math.min(buttons.length - 1, index + 1);
			event.preventDefault();
			buttons[next]?.focus();
		}));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 110, name: `sessionsCustomizeSidebar.${type}`, when: ContextKeyExpr.has('sessionsCustomizeSidebarFocused'),
				getProvider: () => {
					const focused = document.activeElement;
					if (!(focused instanceof HTMLElement) || !root.contains(focused)) return undefined;
					return new AccessibleContentProvider(AccessibleViewProviderId.Customize, { type },
						() => type === AccessibleViewType.View ? root.innerText : localize('customize.navigationHelp', 'Use Tab, Up and Down Arrow, Home or End to move through Customize. Press Enter to open Discover, an installed plugin or skill, or Connections. Plugin and skill group headings open their installed lists. Details open in the main area.'),
						() => (focused.isConnected ? focused : this.discover.domNode).focus(), verbosity);
				},
			}));
		}
	}

	private renderRows(
		rows: GroupRows, category: ResourceGroup, items: readonly { readonly id: string; readonly name: string; }[],
		icon: Icon, activePane: () => CustomizeEditorPane | undefined,
	): void {
		const sorted = [...items].sort((left, right) => left.name.localeCompare(right.name));
		const key = JSON.stringify(sorted.map(({ id, name }) => [id, name]));
		if (key === rows.key) return;
		rows.key = key;
		const document = rows.list.ownerDocument;
		const focused = [...rows.buttons].find(([, button]) => button.hasFocus())?.[0];
		rows.resources.clear();
		rows.list.replaceChildren();
		rows.buttons.clear();
		for (const { id, name } of sorted) {
			const row = h(document, 'li');
			const button = rows.resources.add(new Button(row, {
				...defaultButtonStyles, label: name, title: name, icon, presentation: 'quiet',
				onClick: () => activePane()?.openSidebarResource(category, id, button.domNode),
			}));
			rows.buttons.set(id, button);
			rows.list.append(row);
		}
		if (focused !== undefined) (rows.buttons.get(focused) ?? this.discover).domNode.focus({ preventScroll: true });
	}

	private setCurrent(button: Button, current: boolean): void {
		if (current) button.domNode.setAttribute('aria-current', 'true');
		else button.domNode.removeAttribute('aria-current');
	}

	public override focus(): void { this.discover.focus(); }
}
