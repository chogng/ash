import { JSDOM } from 'jsdom';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import type { Automation, AutomationDefinition, AutomationRun, IAutomationBackendService } from '../../../../../platform/automation/common/automationService.js';
import { IRendererHostService, type IRendererHost } from '../../../../../platform/renderer/common/rendererHost.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IAutomationService } from '../../../../../workbench/contrib/chat/common/automations/automationService.js';
import { SessionsProvidersService, ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import type { ISessionsProvider } from '../../../../services/sessions/common/sessionsProvider.js';
import { AgentHostAutomationStore } from '../../../providers/agentHost/browser/agentHostAutomationStore.js';
import { ProviderAutomationService } from '../../browser/providerAutomationService.js';
import { AutomationRunner } from '../../browser/automationRunner.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { CustomViewService, ICustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { ViewsRegistry } from '../../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../../common/views.js';
import { CommandService } from '../../../../../workbench/services/commands/common/commandService.js';
import { MenuService } from '../../../../../platform/actions/common/menuService.js';
import { Menus } from '../../../../browser/menus.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { AUTOMATIONS_CUSTOM_VIEW_ID } from '../../../sessions/browser/automationsConstants.js';
import '../../../sessions/browser/sessions.contribution.js';
import { AutomationsCardsWidget } from '../../../sessions/browser/views/automationsView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IAutomationDialogService } from '../../../../../workbench/contrib/chat/common/automations/automationDialogService.js';
import { IAutomationRunner } from '../../../../../workbench/contrib/chat/common/automations/automationRunner.js';
import { IChatSessionNavigationService } from '../../../../../workbench/services/chat/common/chatSessionNavigationService.js';

function fixture() {
	const resources = new DisposableStore();
	const services = resources.add(new InstantiationService());
	const registry = resources.add(new SessionsProvidersService());
	services.registerInstance(ISessionsProvidersService, registry);
	const facade = resources.add(services.createInstance(ProviderAutomationService));
	services.registerInstance(IAutomationService, facade);
	const errors: string[] = [];
	services.registerInstance(INotificationService, { error: (message: string) => errors.push(message) } as unknown as INotificationService);
	function host(id: string) {
		const changed = resources.add(new Emitter<void>());
		const connection = observableValue<'connecting' | 'connected' | 'disconnected'>(id, 'connected');
		let plans: Automation[] = [{
			id: 'same-id',
			revision: 1,
			status: 'enabled',
			createdAt: 1,
			updatedAt: 1,
			nextRunAt: null,
			definition: {
				title: id,
				prompt: 'Review changes',
				directory: '/saved',
				session: { type: 'new' },
				schedule: { type: 'interval', anchor: 1, minutes: 60 }
			}
		}];
		let history: AutomationRun[] = [];
		const saves: AutomationDefinition[] = [];
		const requests: string[] = [];
		const stops: string[] = [];
		const backend: IAutomationBackendService = {
			onDidChange: changed.event,
			list: async () => plans,
			save: async (id, revision, definition, status) => {
				saves.push(definition);
				const plan = { ...plans[0]!, id, revision: revision + 1, definition, status };
				plans = [plan];
				changed.fire();
				return plan;
			},
			delete: async () => {
				plans = [];
				changed.fire();
			},
			run: async id => {
				requests.push(id);
				const value = {
					id: 'run',
					automationId: id,
					status: 'pending' as const,
					scheduledAt: 1,
					startedAt: null,
					finishedAt: null,
					sessionId: null,
					threadId: null,
					message: null
				};
				history = [value];
				changed.fire();
				return value;
			},
			runs: async () => history,
			stop: async id => {
				stops.push(id);
				const value = { ...history[0]!, status: 'stopped' as const };
				history = [value];
				changed.fire();
				return value;
			},
		};
		const scope = resources.add(new InstantiationService());
		scope.registerInstance(IRendererHostService, { automation: backend } as unknown as IRendererHost);
		const store = resources.add(scope.createInstance(AgentHostAutomationStore, id, connection));
		const registration = resources.add(registry.registerProvider({ id, label: id, order: 0, automations: store } as unknown as ISessionsProvider));
		return {
			backend,
			store,
			changed,
			connection,
			registration,
			saves,
			requests,
			stops,
			setPlans(value: Automation[]) { plans = value; },
			setHistory(value: AutomationRun[]) { history = value; },
		};
	}
	return { resources, services, registry, facade, host, errors };
}

test('Automations routes provider-scoped identities and never falls back after disconnect or removal', async () => {
	const value = fixture();
	try {
		const first = value.host('one');
		const second = value.host('two');
		await value.facade.refresh();
		const [a, b] = value.facade.automations.get();
		assert.notEqual(a!.id, b!.id);
		assert.equal(value.facade.automations.get().length, 2);
		first.connection.set('disconnected', undefined);
		assert.equal(value.facade.canCreateAutomation('one'), false);
		assert.equal(value.facade.canRunAutomation(a!.id), false);
		await assert.rejects(value.facade.runAutomation(a!.id), /owning automation host/);
		assert.deepEqual(second.requests, []);
		first.registration.dispose();
		await assert.rejects(async () => value.facade.runAutomation(a!.id), /owning provider/);
		assert.deepEqual(second.requests, []);
	} finally { value.resources.dispose(); }
});

test('Stale host reads cannot replace the catalogue after disconnect; reconnect reads it again', async () => {
	const value = fixture();
	try {
		const host = value.host('one');
		await host.store.refresh();
		const original = host.backend.list;
		const pending = new DeferredPromise<readonly Automation[]>();
		host.backend.list = () => pending.p;
		const reading = host.store.refresh();
		host.connection.set('disconnected', undefined);
		await pending.complete([]);
		await reading;
		assert.equal(host.store.catalogueState.get(), 'unavailable');
		assert.equal(host.store.automations.get().length, 1);
		host.backend.list = original;
		host.connection.set('connected', undefined);
		await host.store.refresh();
		assert.equal(host.store.catalogueState.get(), 'ready');
		assert.equal(host.store.automations.get()[0]?.name, 'one');
		const obsolete = new DeferredPromise<readonly Automation[]>();
		host.backend.list = () => obsolete.p;
		const reconnecting = host.store.refresh();
		host.connection.set('disconnected', undefined);
		host.backend.list = original;
		host.connection.set('connected', undefined);
		await obsolete.complete(await original());
		await reconnecting;
		assert.equal(host.store.catalogueState.get(), 'ready');
		assert.equal(host.store.automations.get()[0]?.name, 'one');
	} finally { value.resources.dispose(); }
});

test('Reviewed edits reject changed revisions and changes cannot transfer an automation to another provider', async () => {
	const value = fixture();
	try {
		const host = value.host('one');
		await host.store.refresh();
		const captured = host.store.automations.get()[0]!;
		await assert.rejects(value.facade.updateAutomation(captured.id, { target: { ...captured.target, providerId: 'two' } }), /another provider/);
		host.setPlans([{
			id: 'same-id',
			revision: 2,
			status: 'enabled',
			createdAt: 1,
			updatedAt: 2,
			nextRunAt: null,
			definition: {
				title: 'Changed remotely',
				prompt: captured.prompt,
				directory: captured.target.directory,
				session: captured.target.session,
				schedule: captured.schedule
			}
		}]);
		await host.store.refresh();
		const result = await value.facade.updateAutomationIfUnchanged(captured.id, { name: 'Overwrite' }, captured);
		assert.equal(result.kind, 'conflict');
		assert.deepEqual(host.saves, []);
	} finally { value.resources.dispose(); }
});

test('A confirmed save completes while history is pending, and history failure cannot repeat the write', async () => {
	const value = fixture();
	const history = new DeferredPromise<readonly AutomationRun[]>();
	try {
		const host = value.host('one');
		await host.store.refresh();
		const existing = host.store.automations.get()[0]!;
		host.backend.runs = () => history.p;
		let settled = false;
		const creating = value.facade.createAutomation({ ...existing, name: 'Created once' }).then(result => { settled = true; return result; });
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(settled, true, 'Saving must not wait for run history');
		const created = await creating;
		assert.equal(value.facade.getAutomation(created.id)?.name, 'Created once');
		await history.error(new Error('History unavailable'));
		await assert.rejects(host.store.refresh(), /History unavailable/);
		assert.equal(value.facade.catalogueState.get(), 'ready');
		assert.equal(value.facade.historyState.get(), 'error');
		assert.equal(value.facade.canCreateAutomation('one'), true);
		assert.equal(host.store.canUpdateAutomation(created.id), true);
		assert.equal(host.saves.length, 1);
		const updated = await value.facade.updateAutomation(created.id, { name: 'Edited once' });
		assert.equal(value.facade.getAutomation(updated.id)?.name, 'Edited once');
		assert.equal(host.saves.length, 2);
	} finally {
		await history.complete([]);
		value.resources.dispose();
	}
});

test('A failed history read retains cached rows without hiding successfully read definitions', async () => {
	const value = fixture();
	try {
		const host = value.host('one');
		const original = (await host.backend.list())[0]!;
		const previous: AutomationRun = { id: 'previous', automationId: original.id, status: 'completed', scheduledAt: 1, startedAt: 1, finishedAt: 2, sessionId: 'session', threadId: 'thread', message: null };
		host.setHistory([previous]);
		await host.store.refresh();
		host.setPlans([{ ...original, revision: 2, definition: { ...original.definition, title: 'Fresh definition' } }]);
		host.backend.runs = async () => { throw new Error('History unavailable'); };
		await assert.rejects(host.store.refresh(), /History unavailable/);
		assert.equal(host.store.automations.get()[0]?.name, 'Fresh definition');
		assert.equal(host.store.runs.get()[0]?.status, 'completed');
		assert.equal(host.store.catalogueState.get(), 'ready');
		assert.equal(host.store.historyState.get(), 'error');
	} finally { value.resources.dispose(); }
});

test('A host failure before session creation is reported once after admission', async () => {
	const value = fixture();
	try {
		const host = value.host('one');
		await host.store.refresh();
		const runner = value.services.createInstance(AutomationRunner);
		const operation = runner.runOnce(host.store.automations.get()[0]!);
		assert.deepEqual(await operation.whenDispatched, { kind: 'accepted' });
		const pending = host.store.runs.get()[0]!;
		host.setHistory([{ id: 'run', automationId: 'same-id', status: 'failed', scheduledAt: pending.scheduledAt, startedAt: null, finishedAt: 2, sessionId: null, threadId: null, message: 'Could not create session' }]);
		await host.store.refresh();
		await operation.whenCompleted;
		assert.deepEqual(value.errors, ['Automation one: Could not create session']);
		await host.store.refresh();
		assert.equal(value.errors.length, 1);
	} finally { value.resources.dispose(); }
});

test('Catalogue and history ordering changes retain card identity and keyboard focus', async () => {
	const value = fixture();
	try {
		const host = value.host('one');
		await host.store.refresh();
		const contexts = value.resources.add(new ContextKeyService());
		value.services.registerInstance(IContextKeyService, contexts);
		const configuration = value.resources.add(new InMemoryConfigurationService());
		await configuration.updateValue('accessibility.verbosity.automations', false);
		value.services.registerInstance(IConfigurationService, configuration);
		value.services.registerInstance(IAutomationDialogService, { showAutomationDialog: async () => undefined });
		value.services.registerInstance(IAutomationRunner, value.services.createInstance(AutomationRunner));
		value.services.registerInstance(IChatSessionNavigationService, {} as IChatSessionNavigationService);
		const widget = value.resources.add(value.services.createInstance(AutomationsCardsWidget, browserEnvironment.window.document.body));
		browserEnvironment.window.document.body.append(widget.element);
		const oldTitle = widget.element.querySelector<HTMLButtonElement>('h3 button')!;
		oldTitle.focus();
		const old = (await host.backend.list())[0]!;
		const readHistory = host.backend.runs;
		host.backend.runs = id => id === old.id ? readHistory(id) : Promise.resolve([]);
		host.setPlans([{ ...old, id: 'new', createdAt: 2, definition: { ...old.definition, title: 'Newest' } }, old]);
		await host.store.refresh();
		assert.deepEqual([...widget.element.querySelectorAll('h3 button')].map(element => element.textContent), ['Newest', 'one']);
		assert.equal(browserEnvironment.window.document.activeElement, oldTitle);
		const row = (id: string, scheduledAt: number): AutomationRun => ({ id, automationId: old.id, status: 'completed', scheduledAt, startedAt: 1, finishedAt: 2, sessionId: null, threadId: null, message: id });
		host.setHistory([row('older-run', 1)]);
		await host.store.refresh();
		const oldRow = widget.element.querySelector('[data-run-id]');
		host.setHistory([row('newer-run', 2), row('older-run', 1)]);
		await host.store.refresh();
		assert.deepEqual([...widget.element.querySelectorAll('[data-run-id]')].map(element => JSON.parse(element.getAttribute('data-run-id')!)[1]), ['newer-run', 'older-run']);
		assert.equal(widget.element.querySelectorAll('[data-run-id]')[1], oldRow);
	} finally { value.resources.dispose(); }
});

test('Run cancellation after admission stops the host run once; disposing the frontend does not stop runs', async () => {
	const value = fixture();
	try {
		const host = value.host('one');
		await host.store.refresh();
		const admission = new DeferredPromise<AutomationRun>();
		host.backend.run = async id => {
			host.requests.push(id);
			return admission.p;
		};
		using token = new CancellationTokenSource();
		const runner = value.services.createInstance(AutomationRunner);
		const operation = runner.runOnce(host.store.automations.get()[0]!, token.token);
		token.cancel();
		const run: AutomationRun = {
			id: 'run',
			automationId: 'same-id',
			status: 'pending',
			scheduledAt: 1,
			startedAt: null,
			finishedAt: null,
			sessionId: null,
			threadId: null,
			message: null
		};
		host.setHistory([run]);
		await admission.complete(run);
		await operation.whenCompleted;
		assert.deepEqual(host.stops, ['run']);
		assert.deepEqual(value.errors, []);
		const second = await host.store.runAutomation(host.store.automations.get()[0]!.id);
		const observing = assert.rejects(second.whenCompleted, /may still be active/);
		host.store.dispose();
		await observing;
		assert.deepEqual(host.stops, ['run']);
	} finally { value.resources.dispose(); }
});

test('Automations entry opens a Custom View and never registers a Panel in either window catalog', async () => {
	const value = fixture();
	try {
		const contexts = value.resources.add(new ContextKeyService());
		value.services.registerInstance(IContextKeyService, contexts);
		const storageWindow = new JSDOM('', { url: 'https://automations.test' });
		value.resources.add(toDisposable(() => storageWindow.window.close()));
		const storage = value.resources.add(new BrowserStorageService({ ownerWindow: storageWindow.window as unknown as Window, workspaceId: 'automation-test', flushInterval: 0 }));
		storage.store('sessions.activeCustomView', AUTOMATIONS_CUSTOM_VIEW_ID, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const custom = value.resources.add(new CustomViewService(new NullLoggerService(), storage));
		value.services.registerInstance(ICustomViewService, custom);
		using commands = new CommandService(value.services);
		const menus = new MenuService(commands, contexts);
		const navigation = () => menus.getMenuActions(Menus.SidebarSessionsHeader).flatMap(([, actions]) => actions);
		const host = value.resources.add(WorkbenchContributionsRegistry.createHost(value.services, error => { throw error; }, ['sessions.contrib.automationsCustomView']));
		host.advance(WorkbenchPhase.BlockStartup);
		assert.equal(custom.activeCustomView.get(), undefined);
		assert.deepEqual(navigation(), []);
		host.advance(WorkbenchPhase.BlockRestore);
		assert.equal(CommandsRegistry.getCommand('ash.automation.open'), undefined);
		const provider = value.host('one');
		await value.facade.refresh();
		assert.equal(custom.activeCustomViewOpen.get()?.source, 'restore');
		assert.deepEqual(navigation().map(action => ({ id: action.id, checked: action.checked, enabled: action.enabled })), [{ id: 'sessionsView.manageAutomations', checked: true, enabled: true }]);
		provider.connection.set('disconnected', undefined);
		assert.equal(navigation().length, 1, 'A disconnected provider retains its management entry');
		await commands.executeCommand('sessionsView.manageAutomations');
		assert.equal(custom.activeCustomView.get()?.id, AUTOMATIONS_CUSTOM_VIEW_ID);
		assert.equal(ViewsRegistry.getViewContainer('ash.automation'), undefined);
		assert.equal(SessionsViewRegistry.getViewContainer('ash.automation'), undefined);
		host.dispose();
		assert.equal(custom.activeCustomView.get(), undefined);
		assert.deepEqual(navigation(), []);
		assert.equal(CommandsRegistry.getCommand('ash.automation.open'), undefined);
	} finally { value.resources.dispose(); }
});
