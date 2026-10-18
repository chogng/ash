import { browserEnvironment } from '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import { Event } from '../../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../../nls.js';
import type { AgentSession } from '../../../../../../platform/agentHost/common/agent.js';
import type { Automation, IAutomationBackendService } from '../../../../../../platform/agentHost/common/automation.js';
import { ContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { IRemoteConnectionApi, IRemoteConnectionService, RemoteConnectionService, type RemoteConnectionDefinition } from '../../../../../../platform/remote/common/remoteConnectionService.js';
import { IRendererHostService, type IRendererAgentHost, type IRendererHost } from '../../../../../../platform/renderer/common/rendererHost.js';
import { createDisconnectedRendererApi } from '../../../../../../workbench/browser/rendererApi.js';
import { CommandService } from '../../../../../../workbench/services/commands/common/commandService.js';
import { productLanguagePackCatalogs } from '../../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { NotificationService } from '../../../../../../workbench/services/notification/common/notificationService.js';
import { ISessionsProvidersService, SessionsProvidersService } from '../../../../../services/sessions/browser/sessionsProvidersService.js';
import { ProviderAutomationService } from '../../../../automations/browser/providerAutomationService.js';
import { SSHAgentHostContribution } from '../../browser/sshAgentHost.contribution.js';

ensureNoDisposablesAreLeakedInTestSuite();

const manageHosts = 'sessions.action.manageAgentHosts';
const targets: readonly RemoteConnectionDefinition[] = [
	{ name: 'build-a', host: 'server-a', workspace: '/srv/project' },
	{ name: 'build-b', host: 'server-b', workspace: '/srv/project' },
];

function fixture() {
	const lifetime = new DisposableStore();
	const services = lifetime.add(new InstantiationService());
	const container = browserEnvironment.window.document.createElement('div');
	browserEnvironment.window.document.body.append(container);
	lifetime.add(toDisposable(() => container.remove()));
	const contexts = lifetime.add(new ContextKeyService());
	const quickInput = lifetime.add(new TestQuickInputService({ container, instantiationService: services, contextKeyService: contexts }));
	services.registerInstance(IQuickInputService, quickInput);
	const notifications = lifetime.add(new NotificationService());
	services.registerInstance(INotificationService, notifications);
	const errors: string[] = [];
	lifetime.add(notifications.model.onDidAdd(item => errors.push(String(item.message))));
	const registry = lifetime.add(new SessionsProvidersService());
	services.registerInstance(ISessionsProvidersService, registry);
	services.registerInstance(IRemoteConnectionApi, {
		available: true, list: async () => targets,
		save: async value => value, update: async (_name, value) => value,
		remove: async () => undefined, connect: async () => { throw new Error('Additional hosts must not open another window'); },
	});
	services.registerInstance(IRemoteConnectionService, lifetime.add(services.createInstance(RemoteConnectionService)));
	const opened: string[] = [];
	const closed: string[] = [];
	const renamed: string[] = [];
	const deleted: string[] = [];
	let openResult: ((target: RemoteConnectionDefinition, host: IRendererAgentHost) => Promise<IRendererAgentHost>) | undefined;
	const renderer = createDisconnectedRendererApi();
	services.registerInstance(IRendererHostService, {
		...renderer,
		agentHosts: {
			connect: async target => {
				opened.push(target.name);
				const session: AgentSession = {
					sessionId: 'same-session', title: target.name, status: 'active',
					manager: { status: 'idle', statusChangedAtUnixMs: 0 }, threads: [],
				};
				const plan: Automation = {
					id: 'same-automation', revision: 1, status: 'enabled', createdAt: 1, updatedAt: 1, nextRunAt: null,
					definition: { title: target.name, prompt: 'Review', directory: '/srv/project', session: { type: 'new' }, schedule: { type: 'interval', anchor: 1, minutes: 60 } },
				};
				const automation: IAutomationBackendService = {
					onDidChange: Event.None,
					list: async () => [plan], runs: async () => [], preview: async () => [],
					delete: async id => { deleted.push(`${target.name}:${id}`); },
					save: async () => { throw new Error('Unexpected save'); },
					run: async () => { throw new Error('Unexpected run'); },
					getRun: async () => { throw new Error('Unexpected run read'); },
					stop: async () => { throw new Error('Unexpected stop'); },
					readResult: async () => { throw new Error('Unexpected result'); },
				};
				const api: IRendererHost = {
					...renderer, automation,
					appServer: { ...renderer.appServer, getConnectionState: async () => 'ready' },
					session: {
						...renderer.session,
						subscribeCatalog: async () => ({ sessions: [session] }), unsubscribeCatalog: async () => { },
						rename: async params => { renamed.push(`${target.name}:${params.sessionId}`); return { session: { ...session, title: params.title }, agentTree: { roots: [] } }; },
					},
				};
				const host: IRendererAgentHost = { id: target.name, connection: target, api, ...toDisposable(() => { closed.push(target.name); }) };
				return openResult ? openResult(target, host) : host;
			},
		},
	});
	const contribution = lifetime.add(services.createInstance(SSHAgentHostContribution));
	const commands = lifetime.add(new CommandService(services));
	const automations = lifetime.add(services.createInstance(ProviderAutomationService));
	function picker(): IQuickPick<IQuickPickItem> {
		assert.ok(quickInput.currentQuickInput);
		return quickInput.currentQuickInput as IQuickPick<IQuickPickItem>;
	}
	async function choose(label: string): Promise<void> {
		const current = picker();
		const item = current.items.find(item => 'label' in item && item.label === label);
		assert.ok(item && !('type' in item), `Missing choice: ${label}`);
		current.activeItems = [item];
		current.selectedItems = [item];
		await current.accept();
	}
	async function connect(name: string): Promise<void> {
		const result = commands.executeCommand(manageHosts);
		const shown = new DeferredPromise<void>();
		using listener = quickInput.onShow(() => { void shown.complete(); });
		await choose('Connect a Saved SSH Host…');
		await shown.p;
		await choose(name);
		await result;
	}
	return {
		[Symbol.dispose]: () => lifetime.dispose(),
		services, commands, contribution, registry, automations, quickInput, errors,
		opened, closed, renamed, deleted, connect, choose, picker,
		deferOpen: (next: typeof openResult) => { openResult = next; },
	};
}

test('Agents host command registers independent providers and routes equal backend IDs through their own domains', async () => {
	using context = fixture();
	await context.connect('build-a');
	await context.connect('build-b');
	const [first, second] = context.registry.getProviders();
	assert.ok(first && second);
	assert.notEqual(first.id, second.id);
	const [a, b] = await Promise.all([first.list(), second.list()]);
	assert.equal(a[0]!.sessionId, b[0]!.sessionId);
	await second.renameSession(b[0]!, 'Renamed B');
	assert.deepEqual(context.renamed, ['build-b:same-session']);
	await context.automations.refresh();
	const plans = context.automations.automations.get();
	assert.equal(plans.length, 2);
	assert.notEqual(plans[0]!.id, plans[1]!.id);
	await context.automations.deleteAutomation(plans.find(plan => plan.target.providerId === second.id)!.id);
	assert.deepEqual(context.deleted, ['build-b:same-automation']);
	assert.deepEqual(context.errors, []);
});

test('disconnecting one Agents host unregisters its provider and retains the other host', async () => {
	using context = fixture();
	await context.connect('build-a');
	await context.connect('build-b');
	const result = context.commands.executeCommand(manageHosts);
	await context.choose('build-a');
	await result;
	assert.deepEqual(context.closed, ['build-a']);
	assert.deepEqual(context.registry.getProviders().map(provider => provider.label), ['build-b']);
	await context.automations.refresh();
	assert.deepEqual(context.automations.automations.get().map(plan => plan.name), ['build-b']);
});

test('reselecting an already connected target shares the existing scope', async () => {
	using context = fixture();
	await context.connect('build-a');
	await context.connect('build-a');
	assert.deepEqual(context.opened, ['build-a']);
	assert.equal(context.registry.getProviders().length, 1);
});

test('closing the Agents owner retires pending setup and releases its late result', async () => {
	using context = fixture();
	const entered = new DeferredPromise<void>();
	const release = new DeferredPromise<void>();
	context.deferOpen(async (_target, host) => { void entered.complete(); await release.p; return host; });
	const connecting = context.connect('build-a');
	await entered.p;
	context.contribution.dispose();
	await release.complete();
	await connecting;
	assert.deepEqual(context.closed, ['build-a']);
	assert.deepEqual(context.registry.getProviders(), []);
	assert.deepEqual(context.errors, []);
});

test('the host picker uses Chinese labels and closes on cancellation and owner disposal', async () => {
	using context = fixture();
	const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(chinese.locale, chinese.bundles);
	try {
		const command = context.commands.executeCommand(manageHosts);
		assert.equal(context.picker().ariaLabel, '连接宿主，或选择已连接宿主以断开连接');
		assert.equal(context.picker().items[0]!.label, '连接已保存的 SSH 宿主…');
		context.picker().hide();
		await command;
		const interrupted = context.commands.executeCommand(manageHosts);
		context.contribution.dispose();
		await interrupted;
		assert.equal(context.quickInput.currentQuickInput, undefined);
		assert.deepEqual(context.opened, []);
	} finally { resetNlsResolver(); }
});
