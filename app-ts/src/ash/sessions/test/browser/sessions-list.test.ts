import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter } from "../../../base/common/event.js";
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import type { ISessionsService } from "../../services/sessions/browser/sessionsService.js";
import { SessionsList } from "../../browser/parts/sessionsList.js";

test("SessionsList keeps session buttons and focus while refreshing", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const changes = new Emitter<void>();
	const opened: string[] = [];
	let untitledSessions = [
		{ untitledSessionId: "first", title: "First" },
		{ untitledSessionId: "second", title: "Second" },
	];
	const sessionService = {
		get untitledSessions() { return untitledSessions; },
		sessions: [],
		state: "ready",
		error: undefined,
	} as unknown as ISessionsManagementService;
	const viewService = {
		onDidChange: changes.event,
		activeSelection: undefined,
		openNewSession() {},
		openUntitledSession(id: string) { opened.push(id); },
	} as unknown as ISessionsService;
	const list = new SessionsList(dom.window.document.body, sessionService, viewService, "Sessions", "New Session");
	const buttons = [...list.domNode.querySelectorAll<HTMLButtonElement>(".ash-sessions-list-item")];
	buttons[0].focus();
	untitledSessions = [
		{ untitledSessionId: "first", title: "Renamed" },
		{ untitledSessionId: "second", title: "Second" },
	];
	changes.fire();

	const refreshed = [...list.domNode.querySelectorAll<HTMLButtonElement>(".ash-sessions-list-item")];
	assert.equal(refreshed[0], buttons[0]);
	assert.equal(refreshed[1], buttons[1]);
	assert.equal(dom.window.document.activeElement, buttons[0]);
	assert.equal(refreshed[0].textContent, "Renamed");
	refreshed[0].click();
	assert.deepEqual(opened, ["first"]);

	untitledSessions = [untitledSessions[1]];
	changes.fire();
	assert.deepEqual([...list.domNode.querySelectorAll(".ash-sessions-list-item")], [buttons[1]]);
	buttons[0].click();
	assert.deepEqual(opened, ["first"]);

	list.dispose();
	changes.dispose();
	dom.window.close();
});
