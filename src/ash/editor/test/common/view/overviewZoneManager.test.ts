import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ColorZone, OverviewRulerZone, OverviewZoneManager } from '../../../common/viewModel/overviewZoneManager.js';

test('OverviewZoneManager maps line intervals to minimum visible pixel zones', () => {
	const manager = new OverviewZoneManager(lineNumber => (lineNumber - 1) * 20);
	const first = new OverviewRulerZone(1, 1, 0, 'warning');
	const last = new OverviewRulerZone(100, 100, 0, 'error');
	manager.setLineHeight(20);
	manager.setDOMWidth(6);
	manager.setDOMHeight(100);
	manager.setOuterHeight(2_000);
	manager.setZones([last, first]);

	const zones = manager.resolveColorZones();
	assert.equal(zones.length, 2);
	assert.deepEqual({ from: first.getColorZones()?.from, to: first.getColorZones()?.to }, { from: 0, to: 4 });
	assert.deepEqual({ from: last.getColorZones()?.from, to: last.getColorZones()?.to }, { from: 96, to: 100 });
	assert.equal(manager.getId2Color()[first.getColorZones()!.colorId], 'warning');
});

test('OverviewZoneManager invalidates cached geometry when the ruler changes size', () => {
	const manager = new OverviewZoneManager(lineNumber => (lineNumber - 1) * 10);
	const zone = new OverviewRulerZone(5, 6, 0, 'selection');
	manager.setLineHeight(10);
	manager.setDOMHeight(100);
	manager.setOuterHeight(100);
	manager.setZones([zone]);
	manager.resolveColorZones();
	const first = zone.getColorZones();
	manager.setDOMHeight(200);
	manager.resolveColorZones();
	const second = zone.getColorZones();
	assert.notEqual(second, first);
	assert.deepEqual({ from: second?.from, to: second?.to }, { from: 80, to: 120 });
});

for (const scenario of [
	{
		name: 'pixel ratio 1, DOM height 600',
		pixelRatio: 1,
		domHeight: 600,
		expected: [new ColorZone(12, 24, 1), new ColorZone(120, 132, 2), new ColorZone(360, 384, 3), new ColorZone(588, 600, 4)],
	},
	{
		name: 'pixel ratio 1, DOM height 300',
		pixelRatio: 1,
		domHeight: 300,
		expected: [new ColorZone(6, 12, 1), new ColorZone(60, 66, 2), new ColorZone(180, 192, 3), new ColorZone(294, 300, 4)],
	},
	{
		name: 'pixel ratio 2, DOM height 300',
		pixelRatio: 2,
		domHeight: 300,
		expected: [new ColorZone(12, 24, 1), new ColorZone(120, 132, 2), new ColorZone(360, 384, 3), new ColorZone(588, 600, 4)],
	},
] as const) {
	test(`OverviewZoneManager matches the standard ${scenario.name} geometry`, () => {
		const lineHeight = 20;
		const manager = new OverviewZoneManager(lineNumber => lineHeight * lineNumber);
		manager.setDOMWidth(30);
		manager.setDOMHeight(scenario.domHeight);
		manager.setOuterHeight(50 * lineHeight);
		manager.setLineHeight(lineHeight);
		manager.setPixelRatio(scenario.pixelRatio);
		manager.setZones([
			new OverviewRulerZone(1, 1, 0, '1'),
			new OverviewRulerZone(10, 10, 0, '2'),
			new OverviewRulerZone(30, 31, 0, '3'),
			new OverviewRulerZone(50, 50, 0, '4'),
		]);

		assert.deepEqual(manager.resolveColorZones(), scenario.expected);
	});
}
