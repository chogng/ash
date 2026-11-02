import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IViewsService } from '../../../../../services/views/common/viewsService.js';
import { TestNotificationService } from '../../../../../services/notification/test/common/testNotificationService.js';
import { AgentSessionsPicker } from '../../../browser/agentSessions/agentSessionsPicker.js';
import { IAgentSessionsService } from '../../../browser/agentSessions/agentSessionsService.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import '../../../../../common/theme.js';
import { AgentSessionsControl } from '../../../browser/agentSessions/agentSessionsControl.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { URI } from '../../../../../../base/common/uri.js';
import type { IAgentSession } from '../../../browser/agentSessions/agentSessionsModel.js';
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
services.registerInstance(IEditorService, { openEditor: async () => {} } as unknown as IEditorService);
services.registerInstance(IStorageService, resources.add(new BrowserStorageService({ ownerWindow: window, profileId: 'agent-sessions-fixture', workspaceId: 'agent-sessions-fixture', flushInterval: 0 })));
const colors = [lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme];
const theme = resources.add(new TestThemeService(colors[Number(parameters.get('theme') ?? 0)]!));
resources.add(bindTestColorTheme(theme, document.documentElement));
const changed = resources.add(new Emitter<void>());
const opened: string[] = [];
let menu: IContextMenuDelegate | undefined;
let menuCount = 0;
let newSessionCount = 0;
let refreshCount = 0;
let layoutCount = 0;
let items: readonly IAgentSession[] = Array.from({ length: Number(parameters.get('count') ?? 3) }, (_, index) => ({
	resource: URI.from({ scheme: 'test-session', path: `/${index}` }), target: index === 0 ? { untitledSessionId: `draft-${index}` } : { sessionId: `session-${index}`, threadId: `root-${index}` },
	id: `session-${index}`, kind: index === 0 ? 'draft' : 'session',
	label: `Session ${index}`, description: `Synthetic session ${index}`, active: index === 1,
	inProgress: index === 1, isArchived: () => false, isPinned: () => false,
	getEditorInput: () => ({ resource: URI.from({ scheme: 'test-chat', path: `/${index}` }) }),
	open: () => { opened.push(`session-${index}`); },
}));
services.registerInstance(IContextMenuService, {
	contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
	showContextMenu: (value: IContextMenuDelegate) => { menu = value; menuCount++; },
	hideContextMenu: () => { const current = menu; menu = undefined; current?.onHide?.(false); },
} as IContextMenuService);
const container = document.createElement('main');
container.style.cssText = 'display:flex;flex-direction:column;width:340px;height:440px;font:13px sans-serif;background:var(--ash-sideBar-background);color:var(--ash-foreground)';
document.body.append(container);
const model = {
	onDidChangeSessions: changed.event, get sessions() { return items; }, state: 'ready' as const, error: undefined,
	getSession: (resource: URI) => items.find(item => item.resource.toString() === resource.toString()),
	refresh: async () => { refreshCount++; items = items.map(item => item.id === 'session-1' ? { ...item, label: 'Refreshed Session' } : item); changed.fire(); },
};
services.registerInstance(IAgentSessionsService, { model, getSession: resource => model.getSession(resource) });
const instance = resources.add(new MutableDisposable<DisposableStore>());
let control: AgentSessionsControl;
function createControl(): void {
	const owned = new DisposableStore();
	instance.value = owned;
	control = owned.add(services.createInstance(AgentSessionsControl, container, {
		getActions: (item: IAgentSession) => [{ id: 'rename', label: 'Rename', enabled: true, tooltip: '', run: () => { opened.push(`rename-${item.id.slice('session-'.length)}`); } }],
	}));
	owned.add(observeElementSize(control.element, size => control.layout(size.height, size.width)));
	owned.add(control.onDidRequestNewSession(() => newSessionCount++));
	owned.add(control.onDidRequestToggleLayout(() => layoutCount++));
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
		control.element.querySelector<HTMLElement>('[role="tree"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		await updating;
	},
	opened,
	async rename() { items = items.map(item => item.id === 'session-1' ? { ...item, label: 'Renamed Session' } : item); changed.fire(); await control.update(); },
	async blankDraft() { items = items.map(item => item.kind === 'draft' ? { ...item, label: '', description: 'Provider draft details' } : item); changed.fire(); await control.update(); },
	async pin() { items = items.map(item => item.id === 'session-1' ? { ...item, isPinned: () => true } : item); changed.fire(); await control.update(); },
	async invokeMenu() { await menu?.getActions()[0]?.run(); menu?.onHide?.(false); menu = undefined; await control.update(); },
	get menuOpen() { return menu !== undefined; },
	get menuCount() { return menuCount; },
	get newSessionCount() { return newSessionCount; },
	get refreshCount() { return refreshCount; },
	get layoutCount() { return layoutCount; },
	async chooseFilter(id: string) { await menu?.getActions().find(action => action.id === id)?.run(); menu?.onHide?.(false); menu = undefined; await control.update(); },
	get menuAnchoredToRow() { return menu?.getAnchor() instanceof HTMLElement && (menu.getAnchor() as HTMLElement).getAttribute('role') === 'treeitem'; },
	dispose,
} });
const historyActions: string[] = [];
const historyItems: readonly IAgentSession[] = ['Alpha', 'Beta'].map(label => ({
	id: label, label: `${label} conversation with a long title`, description: '', kind: 'session', active: false,
	resource: URI.from({ scheme: 'test-session', path: `/${label}` }), target: { sessionId: label, threadId: `${label}-root` },
	updatedAt: Date.now() - 300_000, isArchived: () => false, isPinned: () => false,
	open: () => { historyActions.push(`open:${label}`); },
}));
services.registerInstance(ICommandService, {
	onWillExecuteCommand: Event.None, onDidExecuteCommand: Event.None,
	executeCommand: async <T>(id: string, target: unknown): Promise<T> => {
		historyActions.push(`${id === 'sessions.list.togglePin' ? 'pin' : id}:${target}`);
		changed.fire();
		return target as T;
	},
});
services.registerInstance(IViewsService, { focusView: async () => true } as unknown as IViewsService);
services.registerInstance(INotificationService, resources.add(new TestNotificationService()));
const quickInput = resources.add(new TestQuickInputService({ container: document.body, instantiationService: services }));
services.registerInstance(IQuickInputService, quickInput);
const openHistory = document.createElement('button');
openHistory.textContent = 'Open history';
document.body.append(openHistory);
resources.add(addDisposableListener(openHistory, 'click', () => {
	items = historyItems;
	changed.fire();
	void services.createInstance(AgentSessionsPicker, openHistory, undefined).pickAgentSession();
}));
Object.assign(window, { agentSessionsPickerFixture: {
	actions: historyActions,
	hideMenu() { const current = menu; menu = undefined; current?.onHide?.(false); },
	dispose,
} });
resources.add(addDisposableListener(window, 'pagehide', dispose, { once: true }));
