import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IOutputService } from '../../../output/common/output.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { type IServerEventApi } from "../../../../../platform/agentHost/common/appServerApi.js";
import { IStatusbarService, StatusbarAlignment } from "../../../statusbar/browser/statusbar.js";
import { AppServerLanguageServerStatusService } from "../../browser/appServerLanguageServerStatusService.js";
import { type ServerNotification } from "../../../../../../../.build/protocol/typescript/index.js";
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../localization/common/localizationCatalogs.js';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../notification/common/notificationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';

test('managed Rust installation status is localized and clears when acquisition finishes', async () => {
	setARIAContainer(browserEnvironment.window.document.body);
	const events = new FakeServerEvents();
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const output = services.get(IOutputService);
	const statusbar = services.get(IStatusbarService);
	using service = services.createInstance(AppServerLanguageServerStatusService, events);
	setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
	try {
		events.fire({ method: 'language/serverProgress', params: { server: 'rust-analyzer', token: 'ash.language-server.install', title: 'rust-analyzer', message: null, percentage: null, done: false } });
		assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.text, '正在安装 rust-analyzer…');
		assert.match(output.activeChannel?.getText() ?? '', /正在安装 rust-analyzer/);
		events.fire({ method: 'language/serverProgress', params: { server: 'rust-analyzer', token: 'ash.language-server.install', title: null, message: null, percentage: null, done: true } });
		await Promise.resolve();
		assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);
	} finally { resetNlsResolver(); }
});

test("language-server status service publishes channels and only projects active work-done progress", async () => {
	const events = new FakeServerEvents();
	using outputResources = new DisposableStore();
	const services = workbenchInstantiationService(outputResources);
	const output = services.get(IOutputService);
	const statusbar = services.get(IStatusbarService);
	const reveals: Array<[string, string]> = [];
	using revealListener = output.onDidRequestShowChannel(request => reveals.push([request.channel.id, request.focus]));
	using service = services.createInstance(AppServerLanguageServerStatusService, events);

	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);

	events.fire({ method: "language/serverMessage", params: { server: "rust-analyzer", severity: "warning", source: "protocol", show: false, message: "  check failed  " } });
	assert.deepEqual(output.channels.map(channel => channel.label), ["rust-analyzer"]);
	assert.deepEqual(output.activeChannel?.entries.map(entry => [entry.severity, entry.category, entry.text]), [["warning", "protocol", "check failed\n"]]);
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);

	events.fire({ method: "language/serverProgress", params: { server: "rust-analyzer", token: "index", title: "Indexing", message: "1/2 files", percentage: 50, done: false } });
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.text, "rust-analyzer: Indexing 50%");
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.tooltip, "rust-analyzer: Indexing 50%");
	events.fire({ method: "language/serverProgress", params: { server: "rust-analyzer", token: "index", title: null, message: "2/3 files", percentage: 68, done: false } });
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.text, "rust-analyzer: Indexing 68%");
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.id, "status.progress");
	await statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.run?.();
	assert.deepEqual(reveals, [["language-server.rust-analyzer", "take"]]);
	assert.equal(output.activeChannel?.label, "rust-analyzer");
	events.fire({ method: "language/serverProgress", params: { server: "rust-analyzer", token: "index", title: null, message: "done", percentage: null, done: true } });
	await Promise.resolve();
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);

	events.fire({ method: "language/serverMessage", params: { server: "typescript-language-server", severity: "log", source: "stderr", show: false, message: "ready" } });
	assert.deepEqual(output.channels.map(channel => channel.label), ["rust-analyzer", "typescript-language-server"]);
	output.selectChannel("language-server.typescript-language-server");
	output.activeChannel?.clear();
	assert.deepEqual(output.activeChannel?.entries, []);
});

test('progress keeps the server and directory visible when concurrent tasks finish', async () => {
	const events = new FakeServerEvents();
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const output = services.get(IOutputService);
	const statusbar = services.get(IStatusbarService);
	using service = services.createInstance(AppServerLanguageServerStatusService, events);

	events.fire({ method: 'language/serverProgress', params: { server: 'rust-analyzer', dirId: 'backend', token: 'index', title: 'Indexing', message: null, percentage: 68, done: false } });
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.text, 'rust-analyzer — backend: Indexing 68%');
	events.fire({ method: 'language/serverProgress', params: { server: 'typescript-language-server', token: 'load', title: 'Loading project', message: null, percentage: null, done: false } });
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.text, 'typescript-language-server: Loading project');

	events.fire({ method: 'language/serverProgress', params: { server: 'rust-analyzer', dirId: 'backend', token: 'index', title: null, message: null, percentage: null, done: true } });
	await Promise.resolve();
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.text, 'typescript-language-server: Loading project');
	await statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.run?.();
	assert.equal(output.activeChannel?.label, 'typescript-language-server');
	events.fire({ method: 'language/serverProgress', params: { server: 'typescript-language-server', token: 'load', title: null, message: null, percentage: null, done: true } });
	await Promise.resolve();
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);
});

test('progress localizes the presentation while preserving the server-provided title', async () => {
	const events = new FakeServerEvents();
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const output = services.get(IOutputService);
	const statusbar = services.get(IStatusbarService);
	using service = services.createInstance(AppServerLanguageServerStatusService, events);
	setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
	try {
		events.fire({ method: 'language/serverProgress', params: { server: 'rust-analyzer', token: 'index', title: 'Indexing', message: null, percentage: 68, done: false } });
		assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.text, 'rust-analyzer：Indexing 68%');
	} finally { resetNlsResolver(); }
});

test('disposing the language adapter releases its active progress tasks', async () => {
	const events = new FakeServerEvents();
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const statusbar = services.get(IStatusbarService);
	using service = services.createInstance(AppServerLanguageServerStatusService, events);
	events.fire({ method: 'language/serverProgress', params: { server: 'rust-analyzer', token: 'index', title: 'Indexing', message: null, percentage: 68, done: false } });
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.text, 'rust-analyzer: Indexing 68%');
	service.dispose();
	await Promise.resolve();
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);
	events.fire({ method: 'language/serverProgress', params: { server: 'rust-analyzer', token: 'index', title: null, message: null, percentage: 90, done: false } });
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);
});

test("language-server lifecycle is projected from the backend state machine", async () => {
	const events = new FakeServerEvents();
	using outputResources = new DisposableStore();
	const services = workbenchInstantiationService(outputResources);
	const output = services.get(IOutputService);
	const statusbar = services.get(IStatusbarService);
	using service = services.createInstance(AppServerLanguageServerStatusService, events);

	events.fire({ method: "language/serverState", params: { server: "rust-analyzer", state: { type: "starting" } } });
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.text, "rust-analyzer: Starting");
	events.fire({ method: "language/serverState", params: { server: "rust-analyzer", state: { type: "ready" } } });
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);
	events.fire({ method: "language/serverState", params: { server: "rust-analyzer", state: { type: "backingOff", attempt: 2, retryAfterMillis: 1_500 } } });
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.text, "rust-analyzer: Restarting");
	events.fire({ method: "language/serverState", params: { server: "rust-analyzer", state: { type: "crashLoop", restartAttempts: 3, message: "exited 1" } } });
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.text, "rust-analyzer: Failed");
	assert.match(output.activeChannel?.getText() ?? "", /Starting language server/);
	assert.match(output.activeChannel?.getText() ?? "", /restart attempt 2 begins in 1.5s/);
	assert.match(output.activeChannel?.getText() ?? "", /crash loop after 3 restart attempts: exited 1/);
});

class FakeServerEvents implements IServerEventApi {
	private listener: ((event: ServerNotification) => void) | undefined;
	subscribe(listener: (event: ServerNotification) => void) { this.listener = listener; return { dispose: () => { this.listener = undefined; } }; }
	fire(event: ServerNotification): void { this.listener?.(event); }
}

test('language-server errors use localized notifications and reveal their output without a modal dialog', async () => {
	const events = new FakeServerEvents();
	using resources = new DisposableStore();
	const services = workbenchInstantiationService(resources);
	const notifications = services.get(INotificationService);
	assert.ok(notifications instanceof NotificationService);
	let dialogs = 0;
	using dialogListener = services.get(IDialogService).onWillShowDialog(() => { dialogs++; });
	using service = services.createInstance(AppServerLanguageServerStatusService, events);
	setNlsMessages('zh-CN', productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
	try {
		events.fire({ method: 'language/serverMessage', params: { server: 'rust-analyzer', severity: 'error', source: 'protocol', show: true, message: 'Failed to run build scripts of some packages.' } });
		const [notification] = notifications.model.getNotifications();
		assert.equal(notification?.severity, Severity.Error);
		assert.equal(notification?.source, 'rust-analyzer');
		assert.equal(notification?.message, 'Failed to run build scripts of some packages.');
		assert.equal(notification?.actions?.primary?.[0]?.label, '显示输出');
		await notification?.actions?.primary?.[0]?.run();
		assert.equal(services.get(IOutputService).activeChannel?.label, 'rust-analyzer');
		assert.match(services.get(IOutputService).activeChannel?.getText() ?? '', /Failed to run build scripts/);
		assert.equal(dialogs, 0);
		events.fire({ method: 'language/serverMessage', params: { server: 'rust-analyzer', severity: 'warning', source: 'stderr', show: false, message: 'log-only failure' } });
		assert.equal(notifications.model.getNotifications().length, 1);
	} finally { resetNlsResolver(); }
});
