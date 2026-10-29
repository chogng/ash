import { Event } from '../../../../../base/common/event.js';
import { SubmenuAction, type IAction } from '../../../../../base/common/actions.js';
import type { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { IContextMenuService, IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import {
	ILanguageServerService,
	type LanguageServerControl,
	type LanguageServerSnapshot,
} from '../../../../../platform/language/common/languageServerService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../base/common/uri.js';
import { TestWorkspaceService } from '../../../configuration/test/common/testServices.js';
import {
	registerTestWorkbenchInteractionServices,
	workbenchInstantiationService,
} from '../../../../test/browser/workbenchTestServices.js';
import { DisposableStore, Disposable } from '../../../../../base/common/lifecycle.js';
import { IOutputService } from '../../../output/common/output.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { IServerEventApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { IStatusbarService, StatusbarAlignment } from '../../../statusbar/browser/statusbar.js';
import { AppServerLanguageServerStatusService } from '../../browser/appServerLanguageServerStatusService.js';
import { type ServerNotification } from '../../../../../../../.build/protocol/typescript/index.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../localization/common/localizationCatalogs.js';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../notification/common/notificationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';

test('managed Rust download status is localized and clears when acquisition finishes', async () => {
	setARIAContainer(browserEnvironment.window.document.body);
	const events = new FakeServerEvents();
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const output = services.get(IOutputService);
	const statusbar = services.get(IStatusbarService);
	using service = createService(services, events);
	setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
	try {
		events.fire({
			method: 'language/serverProgress',
			params: {
				server: 'rust-analyzer',
				token: 'ash.language-server.download',
				title: 'rust-analyzer',
				message: null,
				percentage: null,
				done: false,
			},
		});
		assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, '正在下载 rust-analyzer…');
		assert.match(output.activeChannel?.getText() ?? '', /正在下载 rust-analyzer/);
		events.fire({
			method: 'language/serverProgress',
			params: {
				server: 'rust-analyzer',
				token: 'ash.language-server.download',
				title: null,
				message: null,
				percentage: null,
				done: true,
			},
		});
		await Promise.resolve();
		assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left), []);
	} finally {
		resetNlsResolver();
	}
});

test('language-server status service publishes channels and only projects active work-done progress', async () => {
	const events = new FakeServerEvents();
	using outputResources = new DisposableStore();
	const services = workbenchInstantiationService(outputResources);
	const output = services.get(IOutputService);
	const statusbar = services.get(IStatusbarService);
	const reveals: Array<[string, string]> = [];
	using revealListener = output.onDidRequestShowChannel(request => reveals.push([request.channel.id, request.focus]));
	using service = createService(services, events);

	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left), []);

	events.fire({
		method: 'language/serverMessage',
		params: {
			server: 'rust-analyzer',
			severity: 'warning',
			source: 'protocol',
			show: false,
			message: '  check failed  ',
		},
	});
	assert.deepEqual(
		output.channels.map(channel => channel.label),
		['rust-analyzer'],
	);
	assert.deepEqual(
		output.activeChannel?.entries.map(entry => [entry.severity, entry.category, entry.text]),
		[['warning', 'protocol', 'check failed\n']],
	);
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left), []);

	events.fire({
		method: 'language/serverProgress',
		params: {
			server: 'rust-analyzer',
			token: 'index',
			title: 'Indexing',
			message: '1/2 files',
			percentage: 50,
			done: false,
		},
	});
	assert.equal(
		statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text,
		'rust-analyzer: Indexing (50%): 1/2 files',
	);
	assert.equal(
		statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.tooltip,
		'rust-analyzer: Indexing (50%): 1/2 files',
	);
	events.fire({
		method: 'language/serverProgress',
		params: {
			server: 'rust-analyzer',
			token: 'index',
			title: null,
			message: '2/3 files',
			percentage: 68,
			done: false,
		},
	});
	assert.equal(
		statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text,
		'rust-analyzer: Indexing (68%): 2/3 files',
	);
	assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[0]?.id, 'status.progress');
	await statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.run?.();
	assert.deepEqual(reveals, [['language-server.rust-analyzer', 'take']]);
	assert.equal(output.activeChannel?.label, 'rust-analyzer');
	events.fire({
		method: 'language/serverProgress',
		params: { server: 'rust-analyzer', token: 'index', title: null, message: 'done', percentage: null, done: true },
	});
	await Promise.resolve();
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left), []);

	events.fire({
		method: 'language/serverMessage',
		params: {
			server: 'typescript-language-server',
			severity: 'log',
			source: 'stderr',
			show: false,
			message: 'ready',
		},
	});
	assert.deepEqual(
		output.channels.map(channel => channel.label),
		['rust-analyzer', 'typescript-language-server'],
	);
	output.selectChannel('language-server.typescript-language-server');
	output.activeChannel?.clear();
	assert.deepEqual(output.activeChannel?.entries, []);
});

for (const multiRoot of [false, true]) {
	test(`language-server output labels disambiguate only multiple workspace roots (${multiRoot ? 'multi-root' : 'single-root'})`, () => {
		const events = new FakeServerEvents();
		using resources = new DisposableStore();
		const services = workbenchInstantiationService(resources);
		const output = services.get(IOutputService);
		const folders = [
			{ id: '3dad1685'.repeat(8), name: 'ash', uri: URI.file('/ash'), index: 0 },
			...(multiRoot ? [{ id: 'api', name: 'api', uri: URI.file('/api'), index: 1 }] : []),
		];
		using workspace = new TestWorkspaceService({ id: 'output-labels', folders });
		using service = createService(services, events, { workspace });
		for (const folder of folders) {
			events.fire({
				method: 'language/serverMessage',
				params: {
					server: 'rust-analyzer',
					dirId: folder.id,
					severity: 'log',
					source: 'stderr',
					show: false,
					message: 'ready',
				},
			});
		}
		assert.deepEqual(
			output.channels.map(channel => ({ id: channel.id, label: channel.label })),
			folders.map(folder => ({
				id: `language-server.rust-analyzer.${folder.id}`,
				label: multiRoot ? `rust-analyzer — ${folder.name}` : 'rust-analyzer',
			})),
		);
	});
}

test('progress keeps the server and directory visible when concurrent tasks finish', async () => {
	const events = new FakeServerEvents();
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const output = services.get(IOutputService);
	const statusbar = services.get(IStatusbarService);
	using service = createService(services, events);

	events.fire({
		method: 'language/serverProgress',
		params: {
			server: 'rust-analyzer',
			dirId: 'backend',
			token: 'index',
			title: 'Indexing',
			message: null,
			percentage: 68,
			done: false,
		},
	});
	assert.equal(
		statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text,
		'rust-analyzer — backend: Indexing (68%)',
	);
	events.fire({
		method: 'language/serverProgress',
		params: {
			server: 'typescript-language-server',
			token: 'load',
			title: 'Loading project',
			message: null,
			percentage: null,
			done: false,
		},
	});
	assert.equal(
		statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text,
		'typescript-language-server: Loading project +1 more',
	);

	events.fire({
		method: 'language/serverProgress',
		params: {
			server: 'rust-analyzer',
			dirId: 'backend',
			token: 'index',
			title: null,
			message: null,
			percentage: null,
			done: true,
		},
	});
	await Promise.resolve();
	assert.equal(
		statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text,
		'typescript-language-server: Loading project',
	);
	await statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.run?.();
	assert.equal(output.activeChannel?.label, 'typescript-language-server');
	events.fire({
		method: 'language/serverProgress',
		params: {
			server: 'typescript-language-server',
			token: 'load',
			title: null,
			message: null,
			percentage: null,
			done: true,
		},
	});
	await Promise.resolve();
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left), []);
});

test('progress localizes the presentation while preserving the server-provided title', async () => {
	const events = new FakeServerEvents();
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const output = services.get(IOutputService);
	const statusbar = services.get(IStatusbarService);
	using service = createService(services, events);
	setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
	try {
		events.fire({
			method: 'language/serverProgress',
			params: {
				server: 'rust-analyzer',
				token: 'index',
				title: 'Indexing',
				message: '2/3 items (demo)',
				percentage: 68,
				done: false,
			},
		});
		assert.equal(
			statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text,
			'rust-analyzer：Indexing（68%）：2/3 items (demo)',
		);
	} finally {
		resetNlsResolver();
	}
});

test('root scanning retains counts and current paths until the server ends the operation', async () => {
	const events = new FakeServerEvents();
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const statusbar = services.get(IStatusbarService);
	using service = createService(services, events);
	const progress = (
		message: string | null,
		percentage: number | null,
		title: string | null = null,
		done = false,
	): void =>
		events.fire({
			method: 'language/serverProgress',
			params: { server: 'rust-analyzer', token: 'rustAnalyzer/Roots Scanned', title, message, percentage, done },
		});
	const text = (): string | undefined => statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text;

	progress('0/10', 0, 'Roots Scanned');
	assert.equal(text(), 'rust-analyzer: Roots Scanned (0%): 0/10');
	progress('3/10: src/nested', 30);
	assert.equal(text(), 'rust-analyzer: Roots Scanned (30%): 3/10: src/nested');
	progress(null, 40);
	assert.equal(text(), 'rust-analyzer: Roots Scanned (40%): 3/10: src/nested');
	progress('9/10: src/final', 90);
	assert.equal(text(), 'rust-analyzer: Roots Scanned (90%): 9/10: src/final');
	progress('', null);
	assert.equal(text(), 'rust-analyzer: Roots Scanned (90%)');
	progress('10/10', 100);
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left), []);
	progress(null, null, null, true);
	await Promise.resolve();
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left), []);
});

test('completed scanning yields to indexing and checking before its end notification', async () => {
	const events = new FakeServerEvents();
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const statusbar = services.get(IStatusbarService);
	using service = createService(services, events);
	const progress = (
		token: string,
		title: string | null,
		message: string | null,
		percentage: number | null,
		done = false,
	): void =>
		events.fire({
			method: 'language/serverProgress',
			params: { server: 'rust-analyzer', token, title, message, percentage, done },
		});
	const text = (): string | undefined => statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text;
	progress('index', 'Indexing', 'crate-a', 20);
	progress('roots', 'Roots Scanned', '1/2', 50);
	assert.equal(text(), 'rust-analyzer: Roots Scanned (50%): 1/2 +1 more');
	progress('roots', null, '2/2', 100);
	assert.equal(text(), 'rust-analyzer: Indexing (20%): crate-a +1 more');
	progress('index', null, 'crate-b', 30);
	assert.equal(text(), 'rust-analyzer: Indexing (30%): crate-b +1 more');
	progress('check', 'cargo check', 'workspace (bin)', null);
	assert.equal(text(), 'rust-analyzer: cargo check: workspace (bin) +2 more');
	progress('roots', null, null, null, true);
	await Promise.resolve();
	assert.equal(text(), 'rust-analyzer: cargo check: workspace (bin) +1 more');
	progress('check', null, null, null, true);
	await Promise.resolve();
	assert.equal(text(), 'rust-analyzer: Indexing (30%): crate-b');
	progress('index', null, null, null, true);
	await Promise.resolve();
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left), []);
});

test('language operations without percentages still show changing progress details', () => {
	const events = new FakeServerEvents();
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const statusbar = services.get(IStatusbarService);
	using service = createService(services, events);

	events.fire({
		method: 'language/serverProgress',
		params: {
			server: 'rust-analyzer',
			token: 'load',
			title: 'Loading',
			message: 'crate-a',
			percentage: null,
			done: false,
		},
	});
	assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, 'rust-analyzer: Loading: crate-a');
	events.fire({
		method: 'language/serverProgress',
		params: {
			server: 'rust-analyzer',
			token: 'load',
			title: null,
			message: 'crate-b',
			percentage: null,
			done: false,
		},
	});
	assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, 'rust-analyzer: Loading: crate-b');
});

test('disposing the language adapter releases its active progress tasks', async () => {
	const events = new FakeServerEvents();
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const statusbar = services.get(IStatusbarService);
	using service = createService(services, events);
	events.fire({
		method: 'language/serverProgress',
		params: {
			server: 'rust-analyzer',
			token: 'index',
			title: 'Indexing',
			message: null,
			percentage: 68,
			done: false,
		},
	});
	assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, 'rust-analyzer: Indexing (68%)');
	service.dispose();
	await Promise.resolve();
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left), []);
	events.fire({
		method: 'language/serverProgress',
		params: { server: 'rust-analyzer', token: 'index', title: null, message: null, percentage: 90, done: false },
	});
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left), []);
});

test('language-server lifecycle is projected from the backend state machine', async () => {
	const events = new FakeServerEvents();
	using outputResources = new DisposableStore();
	const services = workbenchInstantiationService(outputResources);
	const output = services.get(IOutputService);
	const statusbar = services.get(IStatusbarService);
	using service = createService(services, events);

	events.fire({ method: 'language/serverState', params: { server: 'rust-analyzer', state: { type: 'starting' } } });
	assert.match(service.getAccessibleContent(), /workspace|manage language servers/);
	events.fire({ method: 'language/serverState', params: { server: 'rust-analyzer', state: { type: 'ready' } } });
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);
	events.fire({
		method: 'language/serverState',
		params: { server: 'rust-analyzer', state: { type: 'backingOff', attempt: 2, retryAfterMillis: 1_500 } },
	});
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);
	events.fire({
		method: 'language/serverState',
		params: { server: 'rust-analyzer', state: { type: 'crashLoop', restartAttempts: 3, message: 'exited 1' } },
	});
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);
	assert.match(output.activeChannel?.getText() ?? '', /Starting language server/);
	assert.match(output.activeChannel?.getText() ?? '', /restart attempt 2 begins in 1500ms/);
	assert.match(output.activeChannel?.getText() ?? '', /crash loop after 3 restart attempts: exited 1/);
});

class FakeServerEvents implements IServerEventApi {
	private listener: ((event: ServerNotification) => void) | undefined;
	subscribe(listener: (event: ServerNotification) => void) {
		this.listener = listener;
		return {
			dispose: () => {
				this.listener = undefined;
			},
		};
	}
	fire(event: ServerNotification): void {
		this.listener?.(event);
	}
}

test('language-server errors use localized notifications and reveal their output without a modal dialog', async () => {
	const events = new FakeServerEvents();
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const notifications = services.get(INotificationService);
	assert.ok(notifications instanceof NotificationService);
	let dialogs = 0;
	using dialogListener = services.get(IDialogService).onWillShowDialog(() => {
		dialogs++;
	});
	using service = createService(services, events);
	setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
	try {
		events.fire({
			method: 'language/serverMessage',
			params: {
				server: 'rust-analyzer',
				severity: 'error',
				source: 'protocol',
				show: true,
				message: 'Failed to run build scripts of some packages.',
			},
		});
		const [notification] = notifications.model.getNotifications();
		assert.equal(notification?.severity, Severity.Error);
		assert.equal(notification?.source, 'rust-analyzer');
		assert.equal(notification?.message, 'Failed to run build scripts of some packages.');
		assert.equal(notification?.actions?.primary?.[0]?.label, '查看日志');
		await notification?.actions?.primary?.[0]?.run();
		assert.equal(services.get(IOutputService).activeChannel?.label, 'rust-analyzer');
		assert.match(services.get(IOutputService).activeChannel?.getText() ?? '', /Failed to run build scripts/);
		assert.equal(dialogs, 0);
		events.fire({
			method: 'language/serverMessage',
			params: {
				server: 'rust-analyzer',
				severity: 'warning',
				source: 'stderr',
				show: false,
				message: 'log-only failure',
			},
		});
		assert.equal(notifications.model.getNotifications().length, 1);
	} finally {
		resetNlsResolver();
	}
});

function createService(
	services: ReturnType<typeof workbenchInstantiationService>,
	events: IServerEventApi,
	options: {
		workspace?: TestWorkspaceService;
		read?: (dirId?: string) => Promise<LanguageServerSnapshot>;
		controls?: LanguageServerControl[];
		menu?: (delegate: IContextMenuDelegate) => void;
	} = {},
): AppServerLanguageServerStatusService {
	registerTestWorkbenchInteractionServices(services.resources, services);
	const scope = services.createChild();
	scope.registerInstance(IServerEventApi, events);
	if (options.workspace) scope.registerInstance(IWorkspaceContextService, options.workspace);
	else
		scope.registerSingleton(IWorkspaceContextService, () => new TestWorkspaceService({ id: 'empty', folders: [] }));
	scope.registerInstance(ILanguageServerService, {
		read: options.read ?? (async () => ({ revision: 0, configurations: {}, servers: [] })),
		control: async request => {
			options.controls?.push(request);
		},
		configure: async () => {
			throw new Error('Configuration is outside this management fixture');
		},
		removeConfiguration: async () => {
			throw new Error('Configuration is outside this management fixture');
		},
	});
	scope.registerInstance(IContextViewService, {
		container: browserEnvironment.window.document.body,
	} as IContextViewService);
	scope.registerInstance(IContextMenuService, {
		contextMenuStyle: 'custom',
		onDidShowContextMenu: Event.None,
		onDidHideContextMenu: Event.None,
		showContextMenu: delegate => options.menu?.(delegate as IContextMenuDelegate),
		hideContextMenu: () => {},
	});
	scope.registerInstance(IAccessibleViewService, {
		...Disposable.None,
		show: () => true,
		getOpenAriaHint: () => undefined,
		disableHint: async () => {},
		showAccessibleViewHelp() {},
	});
	return scope.createInstance(AppServerLanguageServerStatusService);
}

function workspace(): TestWorkspaceService {
	return new TestWorkspaceService({
		id: 'multi',
		folders: [
			{ id: 'one', name: 'same', uri: URI.file('/one'), index: 0 },
			{ id: 'two', name: 'same', uri: URI.file('/two'), index: 1 },
		],
	});
}

test('management groups identical server and folder names by directory identity and controls their exact scope', async () => {
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const events = new FakeServerEvents();
	const controls: LanguageServerControl[] = [];
	let actions: readonly IAction[] = [];
	using folders = workspace();
	using service = createService(services, events, {
		workspace: folders,
		controls,
		read: async () => ({
			revision: 0,
			configurations: {},
			servers: [{ id: 'fixture', languageIds: ['demo'], state: { type: 'ready' } }],
		}),
		menu: delegate => {
			actions = delegate.getActions();
		},
	});
	assert.equal(services.get(IStatusbarService).getEntries(StatusbarAlignment.Left)[0]?.entry.text, '');
	await service.open();
	const rows = actions.filter((action): action is SubmenuAction => action instanceof SubmenuAction);
	assert.equal(rows.length, 2);
	assert.notEqual(rows[0].id, rows[1].id);
	await rows[0].actions.find(action => action.id.endsWith('.stop'))!.run();
	await rows[1].actions.find(action => action.id.endsWith('.restart'))!.run();
	await actions.find(action => action.id.endsWith('.stopAll'))!.run();
	assert.deepEqual(controls, [
		{ action: 'stop', dirId: 'one', serverId: 'fixture' },
		{ action: 'restart', dirId: 'two', serverId: 'fixture' },
		{ action: 'stop', dirId: 'one' },
		{ action: 'stop', dirId: 'two' },
	]);
	for (const dirId of ['one', 'two'])
		events.fire({
			method: 'language/serverMessage',
			params: { server: 'fixture', dirId, severity: 'warning', source: 'stderr', show: false, message: dirId },
		});
	const channels = services.get(IOutputService).channels;
	assert.equal(channels.length, 2);
	assert.notEqual(channels[0].id, channels[1].id);
	assert.equal(channels[0].label, channels[1].label);
	assert.equal(services.get(IContextKeyService).getValue('languageServerMenuFocused'), true);
	service.dispose();
	assert.equal(services.get(IContextKeyService).getValue('languageServerMenuFocused'), false);
});

test('a lifecycle event wins over an older in-flight catalog snapshot and stopping finishes progress', async () => {
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const events = new FakeServerEvents();
	using folders = workspace();
	let resolve!: (value: LanguageServerSnapshot) => void;
	const pending = new Promise<LanguageServerSnapshot>(done => {
		resolve = done;
	});
	using service = createService(services, events, { workspace: folders, read: () => pending });
	const opening = service.open();
	events.fire({
		method: 'language/serverProgress',
		params: {
			server: 'fixture',
			dirId: 'one',
			token: 'index',
			title: 'Indexing',
			message: null,
			percentage: null,
			done: false,
		},
	});
	events.fire({
		method: 'language/serverState',
		params: { server: 'fixture', dirId: 'one', state: { type: 'stopped' } },
	});
	resolve({
		revision: 0,
		configurations: {},
		servers: [{ id: 'fixture', languageIds: ['demo'], state: { type: 'ready' } }],
	});
	await opening;
	await Promise.resolve();
	assert.match(service.getAccessibleContent(), /fixture: Stopped/);
	assert.equal(
		services
			.get(IStatusbarService)
			.getEntries(StatusbarAlignment.Left)
			.some(entry => entry.id === 'status.progress'),
		false,
	);
	assert.deepEqual(services.get(IStatusbarService).getEntries(StatusbarAlignment.Right), []);
});

test('warnings stay in logs and actionable errors are concise, deduplicated, and localized', async () => {
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const events = new FakeServerEvents();
	using folders = workspace();
	using service = createService(services, events, { workspace: folders });
	const notifications = services.get(INotificationService) as NotificationService;
	events.fire({
		method: 'language/serverMessage',
		params: {
			server: 'fixture',
			dirId: 'one',
			severity: 'warning',
			source: 'protocol',
			show: true,
			message: 'build warning\nlong details',
		},
	});
	assert.equal(notifications.model.getNotifications().length, 0);
	setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
	try {
		const message = {
			server: 'fixture',
			dirId: 'one',
			severity: 'error' as const,
			source: 'protocol' as const,
			show: true,
			message: 'Build scripts failed.\nSTACK_TRACE_SHOULD_STAY_IN_OUTPUT',
		};
		events.fire({ method: 'language/serverMessage', params: message });
		events.fire({ method: 'language/serverMessage', params: message });
		assert.equal(notifications.model.getNotifications().length, 1);
		const [notification] = notifications.model.getNotifications();
		assert.equal(notification.message, 'Build scripts failed.');
		assert.equal(notification.actions?.primary?.[0].label, '查看日志');
		assert.equal(notification.actions?.primary?.[1].label, '重启服务器');
		assert.match(services.get(IOutputService).activeChannel?.getText() ?? '', /STACK_TRACE_SHOULD_STAY_IN_OUTPUT/);
		assert.match(service.getAccessibleContent(), /运行中|未启动/);
	} finally {
		resetNlsResolver();
	}
});

test('catalog refresh removes disabled or uninstalled servers without deleting their logs', async () => {
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const events = new FakeServerEvents();
	using folders = workspace();
	let servers: LanguageServerSnapshot['servers'] = [
		{ id: 'fixture', languageIds: ['demo'], state: { type: 'ready' } },
	];
	let actions: readonly IAction[] = [];
	using service = createService(services, events, {
		workspace: folders,
		read: async () => ({ revision: 0, configurations: {}, servers }),
		menu: delegate => {
			actions = delegate.getActions();
		},
	});
	events.fire({
		method: 'language/serverState',
		params: { server: 'fixture', dirId: 'one', state: { type: 'ready' } },
	});
	await service.open();
	assert.equal(actions.filter(action => action instanceof SubmenuAction).length, 2);
	servers = [];
	events.fire({
		method: 'language/serverState',
		params: { server: 'fixture', dirId: 'one', state: { type: 'stopped' } },
	});
	await service.open();
	assert.equal(actions.filter(action => action instanceof SubmenuAction).length, 0);
	assert.equal(services.get(IOutputService).channels.length, 1);
	assert.match(services.get(IOutputService).channels[0].getText(), /Language server stopped/);
});
