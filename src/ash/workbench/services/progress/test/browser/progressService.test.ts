import assert from "node:assert/strict";
import { mock } from "node:test";
import { test } from "mocha";
import { DeferredPromise } from "../../../../../base/common/async.js";
import { Disposable } from "../../../../../base/common/lifecycle.js";
import { CommandRegistry } from "../../../../../platform/commands/common/commands.js";
import { InstantiationService } from "../../../../../platform/instantiation/common/instantiationService.js";
import { NotificationPriority, NotificationsFilter } from "../../../../../platform/notification/common/notification.js";
import { ProgressLocation, type IProgress, type IProgressStep } from "../../../../../platform/progress/common/progress.js";
import { CommandService } from "../../../commands/common/commandService.js";
import { TestNotificationService } from '../../../notification/test/common/testNotificationService.js';
import { StatusbarAlignment, StatusbarService } from "../../../statusbar/browser/statusbar.js";
import { ProgressService } from "../../browser/progressService.js";

class ProgressFixture extends Disposable {
	readonly statusbar = this._register(new StatusbarService());
	readonly notifications = this._register(new TestNotificationService());
	readonly registry = new CommandRegistry();
	private readonly services = this._register(new InstantiationService());
	readonly commands = this._register(new CommandService(this.services, this.registry));
	readonly progress = this._register(new ProgressService(this.statusbar, this.notifications, this.commands));
}

test("notification progress updates the owning model and follows task completion", async () => {
	using fixture = new ProgressFixture();
	const completion = new DeferredPromise<string>();
	const pending = fixture.progress.withProgress({ location: ProgressLocation.Notification, title: "Indexing", total: 3 }, progress => {
		progress.report({ increment: 1, message: "Reading files" });
		return completion.p;
	});
	const notification = fixture.notifications.model.getNotifications()[0]!;
	assert.equal(notification.message, "Indexing: Reading files");
	assert.deepEqual(notification.progress, { total: 3, worked: 1 });
	await completion.complete("done");
	assert.equal(await pending, "done");
	assert.deepEqual(fixture.notifications.model.getNotifications(), []);
});

test("notification cancellation requests once while the producer's Promise stays pending", async () => {
	using fixture = new ProgressFixture();
	const completion = new DeferredPromise<string>();
	let cancellations = 0;
	let settled = false;
	const pending = fixture.progress.withProgress({ location: ProgressLocation.Notification, title: "Git", cancellable: "Stop" }, () => completion.p, () => { cancellations++; });
	void pending.then(() => { settled = true; });
	const action = fixture.notifications.model.getNotifications()[0]!.actions!.primary![0]!;
	assert.equal(action.label, "Stop");
	await action.run();
	await action.run();
	assert.equal(cancellations, 1);
	assert.equal(settled, false);
	assert.deepEqual(fixture.notifications.model.getNotifications(), []);
	await completion.complete("cancelled by backend");
	assert.equal(await pending, "cancelled by backend");
});

test("window progress activates its command and resumes earlier work after the latest task", async () => {
	using fixture = new ProgressFixture();
	let reveals = 0;
	using command = fixture.registry.register("test.log", () => { reveals++; });
	const first = new DeferredPromise<void>();
	const second = new DeferredPromise<void>();
	let report!: IProgress<IProgressStep>;
	const pendingFirst = fixture.progress.withProgress({ location: ProgressLocation.Window, title: "rust-analyzer", command: "test.log" }, progress => {
		report = progress;
		progress.report({ message: "Indexing 68%" });
		return first.p;
	});
	const entry = fixture.statusbar.getEntries(StatusbarAlignment.Left)[0]!;
	assert.equal(entry.id, "status.progress");
	assert.equal(entry.entry.text, "rust-analyzer: Indexing 68%");
	assert.equal(entry.entry.ariaLabel, entry.entry.text);
	await entry.entry.run?.();
	assert.equal(reveals, 1);
	assert.deepEqual(fixture.notifications.model.getNotifications(), []);
	const pendingSecond = fixture.progress.withProgress({ location: ProgressLocation.Window, title: "typescript-language-server", command: "test.log" }, progress => {
		progress.report({ message: "Loading project" });
		return second.p;
	});
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, "typescript-language-server: Loading project");
	await second.complete(undefined);
	await pendingSecond;
	report.report({ message: "Checking 10%" });
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, "rust-analyzer: Checking 10%");
	await first.complete(undefined);
	await pendingFirst;
	report.report({ message: "Late update" });
	assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Left), []);
});

test('a task at its numeric total cannot hide unfinished window progress while its producer is pending', async () => {
	using fixture = new ProgressFixture();
	const indexing = new DeferredPromise<void>();
	const scanning = new DeferredPromise<void>();
	let scan!: IProgress<IProgressStep>;
	let index!: IProgress<IProgressStep>;
	let indexingSettled = false;
	let scanningSettled = false;
	const first = fixture.progress.withProgress({ location: ProgressLocation.Window, title: 'Indexing', command: 'test.log', total: 100 }, progress => {
		index = progress;
		progress.report({ message: 'crate-a', increment: 20 });
		return indexing.p;
	});
	const second = fixture.progress.withProgress({ location: ProgressLocation.Window, title: 'Roots Scanned', command: 'test.log', total: 100 }, progress => {
		scan = progress;
		progress.report({ message: '1/2', increment: 50 });
		return scanning.p;
	});
	void first.then(() => { indexingSettled = true; });
	void second.then(() => { scanningSettled = true; });
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, 'Roots Scanned: 1/2');
	scan.report({ message: '2/2', increment: 50 });
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, 'Indexing: crate-a');
	assert.equal(indexingSettled, false);
	assert.equal(scanningSettled, false);
	await scanning.complete(undefined);
	await second;
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, 'Indexing: crate-a');
	index.report({ increment: 80 });
	assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Left), []);
	assert.equal(indexingSettled, false);
	await indexing.complete(undefined);
	await first;
	assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Left), []);
});

test("silent notification progress retains history and exposes a window entry", async () => {
	using fixture = new ProgressFixture();
	const completion = new DeferredPromise<void>();
	const pending = fixture.progress.withProgress({ location: ProgressLocation.Notification, title: "Silent task", priority: NotificationPriority.SILENT }, () => completion.p);
	assert.equal(fixture.notifications.model.getNotifications()[0]?.priority, NotificationPriority.SILENT);
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, 'Silent task');
	await completion.complete(undefined);
	await pending;
});

test("task failure and service disposal release presentations without settling the producer", async () => {
	using fixture = new ProgressFixture();
	await assert.rejects(fixture.progress.withProgress({ location: ProgressLocation.Notification, title: "Loading" }, () => Promise.reject(new Error("operation failed"))), /operation failed/);
	assert.deepEqual(fixture.notifications.model.getNotifications(), []);
	const completion = new DeferredPromise<void>();
	let cancellations = 0;
	const pending = fixture.progress.withProgress({ location: ProgressLocation.Notification, title: "Indexing", cancellable: true }, () => completion.p, () => { cancellations++; });
	fixture.progress.dispose();
	assert.equal(cancellations, 1);
	assert.equal(completion.isSettled, false);
	assert.deepEqual(fixture.notifications.model.getNotifications(), []);
	await completion.complete(undefined);
	await pending;
});

test("progress construction requires the registered presentation owners", () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(ProgressService), /Unknown service: statusbarService/);
});

test("a failing cancellation callback does not retain other progress presentations", async () => {
	using fixture = new ProgressFixture();
	const first = new DeferredPromise<void>();
	const second = new DeferredPromise<void>();
	let cancellations = 0;
	const pendingFirst = fixture.progress.withProgress({ location: ProgressLocation.Notification, title: 'First' }, () => first.p, () => { throw new Error('Cancellation callback failed'); });
	const pendingSecond = fixture.progress.withProgress({ location: ProgressLocation.Notification, title: 'Second' }, () => second.p, () => { cancellations++; });
	assert.throws(() => fixture.progress.dispose(), AggregateError);
	assert.equal(cancellations, 1);
	assert.deepEqual(fixture.notifications.model.getNotifications(), []);
	await first.complete(undefined);
	await second.complete(undefined);
	await Promise.all([pendingFirst, pendingSecond]);
});


for (const early of [false, true]) test(`commandless Window progress ${early ? 'finishes before' : 'uses'} the silent-notification delay`, async () => {
	mock.timers.enable({ apis: ['setTimeout'] });
	try {
		using fixture = new ProgressFixture();
		let opens = 0;
		using command = fixture.registry.register('notifications.showList', () => { opens++; });
		const completion = new DeferredPromise<void>();
		const pending = fixture.progress.withProgress({ location: ProgressLocation.Window, title: 'Loading workspace' }, () => completion.p);
		assert.deepEqual(fixture.notifications.model.getNotifications(), []);
		if (early) {
			await completion.complete(undefined);
			await pending;
		}
		mock.timers.tick(149);
		assert.deepEqual(fixture.notifications.model.getNotifications(), []);
		assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Left), []);
		mock.timers.tick(1);
		if (early) {
			assert.deepEqual(fixture.notifications.model.getNotifications(), []);
			assert.deepEqual(fixture.statusbar.getEntries(StatusbarAlignment.Left), []);
		} else {
			assert.equal(fixture.notifications.model.getNotifications()[0]?.priority, NotificationPriority.SILENT);
			await fixture.statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.run?.();
			assert.equal(opens, 1);
			await completion.complete(undefined);
			await pending;
			assert.deepEqual(fixture.notifications.model.getNotifications(), []);
		}
	} finally { mock.timers.reset(); }
});

test('hidden notification progress moves to the status bar and follows visibility without ending the task', async () => {
	using fixture = new ProgressFixture();
	const completion = new DeferredPromise<void>();
	const pending = fixture.progress.withProgress({ location: ProgressLocation.Notification, title: 'Build' }, () => completion.p);
	const item = fixture.notifications.model.getNotifications()[0]!;
	item.updateVisibility(true);
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left).length, 0);
	item.updateVisibility(false);
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, 'Build');
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.showProgress, true);
	item.updateVisibility(true);
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left).length, 0);
	await completion.complete(undefined);
	await pending;
	assert.equal(fixture.notifications.model.getNotifications().length, 0);
});

test('source-muted progress retains the structured source and appears as silent window progress', async () => {
	using fixture = new ProgressFixture();
	const source = { id: 'compiler', label: 'Compiler' };
	fixture.notifications.setFilter({ ...source, filter: NotificationsFilter.ERROR });
	const completion = new DeferredPromise<void>();
	const pending = fixture.progress.withProgress({ location: ProgressLocation.Notification, title: 'Compile', source }, () => completion.p);
	assert.equal(fixture.notifications.model.getNotifications()[0]?.sourceId, source.id);
	assert.equal(fixture.notifications.model.getNotifications()[0]?.priority, NotificationPriority.SILENT);
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.text, 'Compile');
	await completion.complete(undefined);
	await pending;
	assert.equal(fixture.statusbar.getEntries(StatusbarAlignment.Left).length, 0);
});

test('notification progress reports deltas when totals or only the message change', async () => {
	using fixture = new ProgressFixture();
	const completion = new DeferredPromise<void>();
	let reporter!: IProgress<IProgressStep>;
	const pending = fixture.progress.withProgress({ location: ProgressLocation.Notification, title: 'Index', total: 4 }, progress => {
		reporter = progress;
		progress.report({ increment: 1 });
		return completion.p;
	});
	reporter.report({ increment: 1 });
	reporter.report({ message: 'Reading' });
	assert.deepEqual(fixture.notifications.model.getNotifications()[0]?.progress, { total: 4, worked: 2 });
	reporter.report({ total: 8 });
	assert.deepEqual(fixture.notifications.model.getNotifications()[0]?.progress, { total: 8, worked: 2 });
	reporter.report({ increment: 2 });
	assert.deepEqual(fixture.notifications.model.getNotifications()[0]?.progress, { total: 8, worked: 4 });
	await completion.complete(undefined);
	await pending;
});
