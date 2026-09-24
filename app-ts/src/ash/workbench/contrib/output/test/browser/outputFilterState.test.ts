import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { BrowserStorageService } from "../../../../../workbench/services/storage/browser/storageService.js";
import { OutputFilterState } from "../../browser/outputFilterState.js";

const entry = { sequence: 1, timestamp: 1, severity: "warning", category: "lifecycle", text: "Server restart scheduled" } as const;

test("OutputFilterState combines include, exclude, severity, and category filters", () => {
	using filters = new OutputFilterState();
	filters.setText('"server restart" !failed');
	assert.equal(filters.matches(entry), true);
	filters.setText("server !scheduled");
	assert.equal(filters.matches(entry), false);
	filters.setText("");
	filters.setSeverityVisible("warning", false);
	assert.equal(filters.matches(entry), false);
	filters.setSeverityVisible("warning", true);
	filters.setCategoryVisible("lifecycle", false);
	assert.equal(filters.matches(entry), false);
	filters.reset();
	assert.equal(filters.matches(entry), true);
	filters.setMinimumSeverity("error");
	assert.equal(filters.matches(entry), false);
	assert.equal(filters.matches({ ...entry, severity: "error" }), true);
});

test("OutputFilterState restores workspace-local filter choices", () => {
	const browser = new JSDOM("<!doctype html><body></body>", { url: "https://ash.test" });
	using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, applicationId: "output-filter-test", workspaceId: "workspace", backend: browser.window.localStorage, flushInterval: 0 });
	{
		using filters = new OutputFilterState(storage);
		filters.setText("server");
		filters.setSeverityVisible("trace", false);
	}
	{
		using filters = new OutputFilterState(storage);
		assert.equal(filters.text, "server");
		assert.equal(filters.isSeverityVisible("trace"), false);
	}
	browser.window.close();
});
