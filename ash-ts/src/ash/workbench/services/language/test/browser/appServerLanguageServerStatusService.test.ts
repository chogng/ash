import assert from "node:assert/strict";
import { test } from "mocha";
import { type IServerEventApi } from "../../../../../platform/app-server/common/appServerApi.js";
import { DialogService } from "../../../dialogs/common/dialogService.js";
import { OutputService } from "../../../output/browser/outputService.js";
import { StatusbarAlignment, StatusbarService } from "../../../statusbar/browser/statusbar.js";
import { AppServerLanguageServerStatusService } from "../../browser/appServerLanguageServerStatusService.js";
import { type ServerNotification } from "../../../../../../../generated/app-server/index.js";

test("language-server status service publishes channels and only projects active work-done progress", () => {
	const events = new FakeServerEvents();
	using dialogs = new DialogService();
	using output = new OutputService();
	using statusbar = new StatusbarService();
	const reveals: Array<[string, string]> = [];
	using revealListener = output.onDidRequestShowChannel(request => reveals.push([request.channel.id, request.focus]));
	using service = new AppServerLanguageServerStatusService(events, dialogs, output, statusbar);

	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);

	events.fire({ method: "language/serverMessage", params: { server: "rust-analyzer", severity: "warning", source: "protocol", show: false, message: "  check failed  " } });
	assert.deepEqual(output.channels.map(channel => channel.label), ["rust-analyzer"]);
	assert.deepEqual(output.activeChannel?.entries.map(entry => [entry.severity, entry.category, entry.text]), [["warning", "protocol", "check failed\n"]]);
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);

	events.fire({ method: "language/serverProgress", params: { server: "rust-analyzer", token: "index", title: "Indexing", message: "1/2 files", percentage: 50, done: false } });
	assert.equal(service.getProgress()[0]?.title, "Indexing");
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.text, "Indexing 50%");
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.run?.(), undefined);
	assert.deepEqual(reveals, [["language-server.rust-analyzer", "take"]]);
	assert.equal(output.activeChannel?.label, "rust-analyzer");
	events.fire({ method: "language/serverProgress", params: { server: "rust-analyzer", token: "index", title: null, message: "done", percentage: null, done: true } });
	assert.deepEqual(service.getProgress(), []);
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);

	events.fire({ method: "language/serverMessage", params: { server: "typescript-language-server", severity: "log", source: "stderr", show: false, message: "ready" } });
	assert.deepEqual(output.channels.map(channel => channel.label), ["rust-analyzer", "typescript-language-server"]);
	output.selectChannel("language-server.typescript-language-server");
	output.activeChannel?.clear();
	assert.deepEqual(output.activeChannel?.entries, []);
});

test("language-server lifecycle is projected from the backend state machine", () => {
	const events = new FakeServerEvents();
	using dialogs = new DialogService();
	using output = new OutputService();
	using statusbar = new StatusbarService();
	using service = new AppServerLanguageServerStatusService(events, dialogs, output, statusbar);

	events.fire({ method: "language/serverState", params: { server: "rust-analyzer", state: { type: "starting" } } });
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.text, "rust-analyzer: Starting");
	events.fire({ method: "language/serverState", params: { server: "rust-analyzer", state: { type: "ready" } } });
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Right), []);
	events.fire({ method: "language/serverState", params: { server: "rust-analyzer", state: { type: "backingOff", attempt: 2, retryAfterMillis: 1_500 } } });
	assert.equal(statusbar.getEntries(StatusbarAlignment.Right)[0]?.entry.text, "rust-analyzer: Restarting");
	events.fire({ method: "language/serverState", params: { server: "rust-analyzer", state: { type: "crashLoop", restartAttempts: 3, message: "exited 1" } } });
	assert.deepEqual(service.getStates(), [{ server: "rust-analyzer", state: "crashLoop", restartAttempts: 3, message: "exited 1" }]);
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
