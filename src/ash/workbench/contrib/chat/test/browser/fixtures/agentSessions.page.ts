import '../../../../../common/theme.js';
import { AgentSessionsControl } from '../../../browser/agentSessions/agentSessionsControl.js';
import type { IAgentSessionListItem } from '../../../browser/agentSessions/agentSessionsModel.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import type { IContextMenuDelegate } from '../../../../../../base/browser/contextmenu.js';
import { DisposableTracker, installDisposableTracker, DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { IStorageService } from '../../../../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../../../services/storage/browser/storageService.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { observeElementSize } from '../../../../../../base/browser/observer.js';
import { addDisposableListener } from '../../../../../../base/browser/dom.js';
import { formatNlsMessage, setNlsResolver } from '../../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../services/localization/common/localizationCatalogs.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';

const parameters = new URLSearchParams(location.search);
const locale = parameters.get('locale');
const catalog = productLanguagePackCatalogs.find(candidate => candidate.locale === locale);
if (catalog) setNlsResolver((bundle, key, fallback, args) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, args));
const tracker = new DisposableTracker();
const tracking = installDisposableTracker(tracker);
const resources = new DisposableStore();
let disposed = false;
function dispose(): void {
	if (disposed) return;
	disposed = true;
	resources.dispose();
	tracking[Symbol.dispose]();
	tracker.assertNoLeaks();
}
const services = resources.add(new InstantiationService());
const configuration = resources.add(new InMemoryConfigurationService());
services.registerInstance(IConfigurationService, configuration);
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, profileId: 'agent-sessions-fixture', workspaceId: 'agent-sessions-fixture', flushInterval: 0 })));
const colors = [lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme];
const theme = resources.add(new TestThemeService(colors[Number(parameters.get('theme') ?? 0)]!));
resources.add(bindTestColorTheme(theme, document.documentElement));
const changed = resources.add(new Emitter<void>());
const opened: string[] = [];
let menu: IContextMenuDelegate | undefined;
let menuCount = 0;
let newSessionCount = 0;
let items: readonly IAgentSessionListItem[] = Array.from({ length: Number(parameters.get('count') ?? 3) }, (_, index) => ({
	id: `session-${index}`, kind: index === 0 ? 'draft' : 'session',
	title: `Session ${index}`, description: `Synthetic session ${index}`, active: index === 1,
	getActions: () => [{ id: 'rename', label: 'Rename', enabled: true, tooltip: '', run: () => opened.push(`rename-${index}`) }],
	open: () => opened.push(`session-${index}`),
}));
services.registerInstance(IContextMenuService, {
	contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
	showContextMenu: (value: IContextMenuDelegate) => { menu = value; menuCount++; },
	hideContextMenu: () => { const current = menu; menu = undefined; current?.onHide?.(false); },
} as IContextMenuService);
const container = document.createElement('main');
container.style.cssText = 'display:flex;flex-direction:column;width:340px;height:440px;font:13px sans-serif;background:var(--ash-sideBar-background);color:var(--ash-foreground)';
document.body.append(container);
const instance = resources.add(new MutableDisposable<DisposableStore>());
let control: AgentSessionsControl;
function createControl(): void {
	const owned = new DisposableStore();
	instance.value = owned;
	control = owned.add(services.createInstance(AgentSessionsControl, container, { onDidChange: changed.event, get items() { return items; }, state: 'ready', error: undefined }));
	owned.add(observeElementSize(control.domNode, size => control.layout(size.height, size.width)));
	owned.add(control.onDidRequestNewSession(() => newSessionCount++));
}
createControl();
Object.assign(window, { agentSessionsFixture: {
	async ready() { await control.update(); },
	focus() { control.focus(); },
	setVisible(visible: boolean) { control.setVisible(visible); },
	async restart() { createControl(); await control.update(); },
	async doubleClickMode() { await configuration.updateValue('workbench.list.openMode', 'doubleClick'); },
	async refreshDuringNavigation() {
		const updating = control.update();
		control.domNode.querySelector<HTMLElement>('[role="tree"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		await updating;
	},
	opened,
	async rename() { items = items.map(item => item.id === 'session-1' ? { ...item, title: 'Renamed Session' } : item); changed.fire(); await control.update(); },
	async pin() { items = items.map(item => item.id === 'session-1' ? { ...item, pinned: true } : item); changed.fire(); await control.update(); },
	async invokeMenu() { await menu?.getActions()[0]?.run(); menu?.onHide?.(false); menu = undefined; await control.update(); },
	get menuOpen() { return menu !== undefined; },
	get menuCount() { return menuCount; },
	get newSessionCount() { return newSessionCount; },
	get menuAnchoredToRow() { return menu?.getAnchor() instanceof HTMLElement && (menu.getAnchor() as HTMLElement).getAttribute('role') === 'treeitem'; },
	dispose,
} });
resources.add(addDisposableListener(window, 'pagehide', dispose, { once: true }));
