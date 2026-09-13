import assert from "node:assert/strict";
import { test } from "mocha";
import { URI } from "../../../../base/common/uri.js";
import { MarkerService, MarkerSeverity } from "../../../../platform/markers/common/markers.js";

test("marker service replaces an owner atomically and reports affected resources", () => {
	using service = new MarkerService();
	const first = URI.file("C:\\project\\src\\main.rs");
	const second = URI.file("C:\\project\\src\\lib.rs");
	const changes: string[][] = [];
	service.onDidChange(change => changes.push(change.resources.map(resource => resource.toString())));

	service.set("language", [createMarker(first, MarkerSeverity.Error, "first")]);
	assert.equal(service.read(first, "language").length, 1);
	assert.equal(service.read(second).length, 0);

	service.set("language", [createMarker(second, MarkerSeverity.Warning, "second")]);
	assert.equal(service.read(first, "language").length, 0);
	assert.deepEqual(service.read(second, "language").map(marker => marker.message), ["second"]);
	assert.deepEqual(changes, [[first.toString()], [first.toString(), second.toString()]]);
});

test("marker service keeps owners isolated and supports resource removal", () => {
	using service = new MarkerService();
	const resource = URI.file("C:\\project\\src\\main.rs");
	service.set("language", [createMarker(resource, MarkerSeverity.Error, "language")]);
	service.set("tasks", [createMarker(resource, MarkerSeverity.Warning, "task")]);

	service.remove("language", resource);
	assert.deepEqual(service.getAll().map(marker => marker.message), ["task"]);

	service.remove("tasks");
	assert.deepEqual(service.getAll(), []);
});

test("marker service rejects invalid marker input", () => {
	using service = new MarkerService();
	const resource = URI.file("C:\\project\\src\\main.rs");

	assert.throws(
		() => service.set("language", [createMarker(resource, "invalid" as MarkerSeverity, "message")]),
		/Unknown marker severity/u,
	);
	assert.throws(
		() => service.set("language", [createMarker(resource, MarkerSeverity.Error, "")]),
		/Marker message must not be empty/u,
	);
});

function createMarker(resource: URI, severity: MarkerSeverity, message: string) {
	return {
		resource,
		range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 1 } },
		severity,
		message,
	};
}
