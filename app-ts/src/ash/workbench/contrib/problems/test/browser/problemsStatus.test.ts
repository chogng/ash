import assert from "node:assert/strict";
import { test } from "mocha";
import { URI } from "../../../../../base/common/uri.js";
import { MarkerService, MarkerSeverity } from "../../../../../platform/markers/common/markers.js";
import { ProblemsStatusContribution } from "../../../../../workbench/contrib/problems/browser/problemsStatus.js";
import { StatusbarAlignment, StatusbarService } from "../../../../../workbench/services/statusbar/browser/statusbar.js";
import type { IViewsService } from "../../../../../workbench/services/views/browser/viewsService.js";

test("Problems status projects and updates workspace error and warning counts", () => {
	using markerService = new MarkerService();
	const resource = URI.file("C:\\project\\src\\main.rs");
	markerService.set("fixture", [
		marker(resource, MarkerSeverity.Error, "first"),
		marker(resource, MarkerSeverity.Error, "second"),
		marker(resource, MarkerSeverity.Warning, "third"),
		marker(resource, MarkerSeverity.Information, "fourth"),
	]);
	const focusedViews: string[] = [];
	const viewsService = {
		focusView: (viewId: string) => { focusedViews.push(viewId); return true; },
	} as unknown as IViewsService;
	using statusbar = new StatusbarService();
	using contribution = new ProblemsStatusContribution({ statusbarService: statusbar, markerService, viewsService });

	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left).map(item => item.id), ["ash.status.problems"]);
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.segments?.map(segment => segment.text), ["2", "1"]);
	assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.run?.(), true);
	assert.deepEqual(focusedViews, ["ash.problems"]);

	markerService.set("fixture", [
		marker(resource, MarkerSeverity.Warning, "fifth"),
		marker(resource, MarkerSeverity.Warning, "sixth"),
	]);
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.segments?.map(segment => segment.text), ["0", "2"]);
	assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.tooltip, "Warnings: 2");

	contribution.dispose();
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left), []);
});

function marker(resource: URI, severity: MarkerSeverity, message: string) {
	return {
		resource,
		range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 1 } },
		severity,
		message,
	};
}
