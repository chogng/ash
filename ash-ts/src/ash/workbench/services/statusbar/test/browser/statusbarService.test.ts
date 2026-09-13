import assert from "node:assert/strict";
import { test } from "mocha";
import { StatusbarAlignment, StatusbarService } from "../../../../../workbench/services/statusbar/browser/statusbar.js";

test("status bar entries are grouped and ordered by alignment", () => {
	using service = new StatusbarService();
	using lowPriority = service.addEntry(
		{ text: "Low" },
		{
			id: "test.low",
			alignment: StatusbarAlignment.Left,
			priority: 1,
		},
	);
	using right = service.addEntry(
		{ text: "Right" },
		{
			id: "test.right",
			alignment: StatusbarAlignment.Right,
		},
	);
	using highPriority = service.addEntry(
		{ text: "High" },
		{
			id: "test.high",
			alignment: StatusbarAlignment.Left,
			priority: 10,
		},
	);

	assert.deepEqual(
		service.getEntries(StatusbarAlignment.Left).map(({ id }) => id),
		["test.high", "test.low"],
	);
	assert.deepEqual(
		service.getEntries(StatusbarAlignment.Right).map(({ id }) => id),
		["test.right"],
	);
});

test("status bar entry accessors update and remove their entry", () => {
	using service = new StatusbarService();
	let changes = 0;
	using listener = service.onDidChangeEntries(() => {
		changes += 1;
	});
	const entry = service.addEntry(
		{ text: "Connecting" },
		{
			id: "test.connection",
			alignment: StatusbarAlignment.Left,
		},
	);

	entry.update({
		text: "Connected",
		tooltip: "The app server is connected",
	});
	assert.deepEqual(
		service.getEntries(StatusbarAlignment.Left)[0]?.entry,
		{
			text: "Connected",
			tooltip: "The app server is connected",
		},
	);

	entry.dispose();
	assert.deepEqual(service.getEntries(StatusbarAlignment.Left), []);
	assert.equal(changes, 3);
});

test("status bar entry ids are unique while registered", () => {
	using service = new StatusbarService();
	using entry = service.addEntry(
		{ text: "First" },
		{
			id: "test.unique",
			alignment: StatusbarAlignment.Left,
		},
	);

	assert.throws(
		() => service.addEntry(
			{ text: "Duplicate" },
			{
				id: "test.unique",
				alignment: StatusbarAlignment.Right,
			},
		),
		/already exists/,
	);
});
