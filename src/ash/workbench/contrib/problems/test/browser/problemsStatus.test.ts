import { StatusbarService } from '../../../../browser/parts/statusbar/statusbarPart.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { ProblemsStatusContribution } from '../../../../../workbench/contrib/problems/browser/problemsStatus.js';
import { StatusbarAlignment } from '../../../../../workbench/services/statusbar/browser/statusbar.js';
import type { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';

test('Problems status projects and updates workspace error and warning counts', async () => {
	using markerService = new MarkerService();
	const resource = URI.file('C:\\project\\src\\main.rs');
	markerService.changeAll('fixture', [
		marker(resource, MarkerSeverity.Error, 'first'),
		marker(resource, MarkerSeverity.Error, 'second'),
		marker(resource, MarkerSeverity.Warning, 'third'),
		marker(resource, MarkerSeverity.Info, 'fourth'),
	]);
	const focusedViews: string[] = [];
	const viewsService = {
		focusView: async (viewId: string) => {
			focusedViews.push(viewId);
			return true;
		},
	} as unknown as IViewsService;
	using statusbar = new StatusbarService();
	using contribution = new ProblemsStatusContribution({ statusbarService: statusbar, markerService, viewsService });

	assert.deepEqual(
		statusbar.getEntries(StatusbarAlignment.Left).map(item => item.id),
		['ash.status.problems'],
	);
	assert.deepEqual(
		statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.segments?.map(segment => segment.text),
		['2', '1'],
	);
	assert.equal(await statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.run?.(), true);
	assert.deepEqual(focusedViews, ['ash.problems']);

	markerService.changeAll('fixture', [
		marker(resource, MarkerSeverity.Warning, 'fifth'),
		marker(resource, MarkerSeverity.Warning, 'sixth'),
	]);
	assert.deepEqual(
		statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.segments?.map(segment => segment.text),
		['0', '2'],
	);
	assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.tooltip, 'Warnings: 2');

	try {
		initializeTestLocalization('zh-CN');
		markerService.changeAll('fixture', [
			marker(resource, MarkerSeverity.Error, 'error'),
			marker(resource, MarkerSeverity.Warning, 'warning'),
		]);
		assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.tooltip, '错误：1，警告：1');
		assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.ariaLabel, '错误：1，警告：1');
		markerService.changeAll('fixture', []);
		assert.equal(statusbar.getEntries(StatusbarAlignment.Left)[0]?.entry.tooltip, '没有问题');
	} finally {
		resetNlsResolver();
	}

	contribution.dispose();
	assert.deepEqual(statusbar.getEntries(StatusbarAlignment.Left), []);
});

function marker(resource: URI, severity: MarkerSeverity, message: string) {
	return {
		resource,
		marker: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2, severity, message },
	};
}
