import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { BrowserProgressService } from "../../../../platform/progress/browser/progressService.js";

test("browser progress service reports progress and cleans up completed work", async () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	try {
		using service = new BrowserProgressService(browser.window.document.body);
		const changes: string[] = [];
		service.onDidChange(change => changes.push(change.kind));
		const handle = service.startProgress({ title: "Indexing", total: 3 });

		handle.report({ increment: 1, message: "Reading files" });
		assert.equal(browser.window.document.querySelector("progress")?.value, 1);
		assert.equal(browser.window.document.querySelector(".ash-progress-message")?.textContent, "Reading files");
		handle.done();
		assert.deepEqual(changes, ["started", "updated", "done"]);
		assert.equal(browser.window.document.querySelectorAll(".ash-progress-item").length, 0);

		const result = await service.withProgress({ title: "Saving" }, async progress => {
			progress.report({ message: "Writing" });
			return "saved";
		});
		assert.equal(result, "saved");
		assert.equal(browser.window.document.querySelectorAll(".ash-progress-item").length, 0);
	} finally {
		browser.window.close();
	}
});

test("browser progress service aborts cancellable work from its button", () => {
	const browser = new JSDOM("<!doctype html><body></body>");
	try {
		using service = new BrowserProgressService(browser.window.document.body);
		const handle = service.startProgress({ title: "Long task", cancellable: true });
		(browser.window.document.querySelector<HTMLButtonElement>(".ash-progress-cancel")!).click();

		assert.equal(handle.signal.aborted, true);
		assert.equal(browser.window.document.querySelectorAll(".ash-progress-item").length, 0);
	} finally {
		browser.window.close();
	}
});
