import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../base/common/uri.js';
import { MarkerService } from '../../../../platform/markers/common/markerService.js';
import { MarkerSeverity, MarkerTag, type IMarkerData, type IResourceMarker } from '../../../../platform/markers/common/markers.js';

test('marker service replaces an owner atomically and reports affected resources', () => {
	using service = new MarkerService();
	const first = URI.file('C:\\project\\src\\main.rs');
	const second = URI.file('C:\\project\\src\\lib.rs');
	const changes: string[][] = [];
	service.onMarkerChanged(resources => changes.push(resources.map(resource => resource.toString())));

	service.changeAll('language', [createMarker(first, MarkerSeverity.Error, 'first')]);
	assert.equal(service.read({ resource: first, owner: 'language' }).length, 1);
	assert.equal(service.read({ resource: second }).length, 0);

	service.changeAll('language', [createMarker(second, MarkerSeverity.Warning, 'second')]);
	assert.equal(service.read({ resource: first, owner: 'language' }).length, 0);
	assert.deepEqual(
		service.read({ resource: second, owner: 'language' }).map(marker => marker.message),
		['second'],
	);
	assert.deepEqual(changes, [[first.toString()], [first.toString(), second.toString()]]);
});

test('marker service keeps owners isolated and supports resource removal', () => {
	using service = new MarkerService();
	const resource = URI.file('C:\\project\\src\\main.rs');
	service.changeAll('language', [createMarker(resource, MarkerSeverity.Error, 'language')]);
	service.changeAll('tasks', [createMarker(resource, MarkerSeverity.Warning, 'task')]);

	service.remove('language', [resource]);
	assert.deepEqual(
		service.read().map(marker => marker.message),
		['task'],
	);

	service.changeAll('tasks', []);
	assert.deepEqual(service.read(), []);
});

test('marker service replaces one owner resource without changing its other resources', () => {
	using service = new MarkerService();
	const first = URI.file('/project/first.ts');
	const second = URI.file('/project/second.ts');
	const changes: string[][] = [];
	service.onMarkerChanged(resources => changes.push(resources.map(resource => resource.toString())));
	service.changeAll('host', [createMarker(first, MarkerSeverity.Error, 'old'), createMarker(second, MarkerSeverity.Warning, 'keep')]);
	service.changeAll('other', [createMarker(first, MarkerSeverity.Hint, 'other')]);
	changes.length = 0;

	service.changeOne('host', first, [createMarker(first, MarkerSeverity.Error, 'new').marker]);
	assert.deepEqual(
		service.read({ resource: first, owner: 'host' }).map(marker => marker.message),
		['new'],
	);
	assert.deepEqual(
		service.read({ resource: second, owner: 'host' }).map(marker => marker.message),
		['keep'],
	);
	assert.deepEqual(
		service.read({ resource: first, owner: 'other' }).map(marker => marker.message),
		['other'],
	);
	assert.deepEqual(changes, [[first.toString()]]);

	service.changeOne('host', first, []);
	assert.deepEqual(service.read({ resource: first, owner: 'host' }), []);
	assert.deepEqual(
		service.read({ resource: second, owner: 'host' }).map(marker => marker.message),
		['keep'],
	);
	assert.deepEqual(changes, [[first.toString()], [first.toString()]]);
});

test('marker queries combine resource, owner, severity masks and limits', () => {
	using service = new MarkerService();
	const first = URI.file('/project/first.ts');
	const second = URI.file('/project/second.ts');
	service.changeAll('language', [createMarker(first, MarkerSeverity.Error, 'error'), createMarker(first, MarkerSeverity.Warning, 'warning'), createMarker(second, MarkerSeverity.Info, 'info')]);
	service.changeAll('tasks', [createMarker(first, MarkerSeverity.Hint, 'hint')]);
	assert.deepEqual(
		service.read({ owner: 'language', resource: first, severities: MarkerSeverity.Error | MarkerSeverity.Warning }).map(marker => marker.message),
		['error', 'warning'],
	);
	assert.deepEqual(
		service.read({ severities: MarkerSeverity.Warning | MarkerSeverity.Info, take: 1 }).map(marker => marker.message),
		['warning'],
	);
	assert.deepEqual(service.read({ owner: 'missing' }), []);
	assert.deepEqual(service.read({ severities: 0 }), []);
	assert.equal(service.read({ take: 0 }).length, 4);
	assert.deepEqual(service.getStatistics(), { errors: 1, warnings: 1, infos: 1, unknowns: 1 });
	service.changeOne('language', first, []);
	assert.deepEqual(service.getStatistics(), { errors: 0, warnings: 0, infos: 1, unknowns: 1 });
	service.changeAll('language', []);
	service.changeAll('tasks', []);
	assert.deepEqual(service.getStatistics(), { errors: 0, warnings: 0, infos: 0, unknowns: 0 });
});

test('marker metadata and coordinates survive storage without aliasing producer updates', () => {
	using service = new MarkerService();
	const resource = URI.file('/project/main.ts');
	const diagnostic: IMarkerData = {
		startLineNumber: 2,
		startColumn: 3,
		endLineNumber: 4,
		endColumn: 5,
		severity: MarkerSeverity.Warning,
		message: 'unused',
		source: 'compiler',
		code: { value: '0', target: URI.parse('https://example.com/diagnostic/0') },
		modelVersionId: 42,
		tags: [MarkerTag.Unnecessary],
		origin: 'language',
		relatedInformation: [{ resource, message: 'declared here', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }],
	};
	service.changeOne('test', resource, [diagnostic]);
	assert.deepEqual(service.read(), [{ ...diagnostic, owner: 'test', resource }]);
	assert.ok(typeof diagnostic.code === 'object');
	diagnostic.code.value = 'changed';
	diagnostic.tags!.push(MarkerTag.Deprecated);
	diagnostic.relatedInformation![0].message = 'changed';
	const stored = service.read()[0];
	assert.deepEqual(stored.code, { value: '0', target: URI.parse('https://example.com/diagnostic/0') });
	assert.deepEqual(stored.tags, [MarkerTag.Unnecessary]);
	assert.equal(stored.relatedInformation![0].message, 'declared here');
});

test('bulk removal reports each affected resource once and ignores absent resources', () => {
	using service = new MarkerService();
	const first = URI.file('/project/first.ts');
	const second = URI.file('/project/second.ts');
	service.changeAll('test', [createMarker(first, MarkerSeverity.Error, 'first'), createMarker(first, MarkerSeverity.Warning, 'second'), createMarker(second, MarkerSeverity.Info, 'third')]);
	const changes: string[][] = [];
	service.onMarkerChanged(resources => changes.push(resources.map(resource => resource.toString())));
	service.remove('test', [first, first, URI.file('/missing')]);
	assert.deepEqual(
		service.read().map(marker => marker.message),
		['third'],
	);
	service.changeAll('test', []);
	service.changeOne('test', first, []);
	assert.deepEqual(changes, [[first.toString()], [second.toString()]]);
});

test('disposing the marker owner releases listeners and rejects further access', () => {
	const service = new MarkerService();
	let events = 0;
	using listener = service.onMarkerChanged(() => events++);
	service.changeOne('test', URI.file('/project/main.ts'), [createMarker(URI.file('/project/main.ts'), MarkerSeverity.Error, 'error').marker]);
	service.dispose();
	assert.equal(events, 1);
	assert.throws(() => service.read(), /disposed/i);
});

function createMarker(resource: URI, severity: MarkerSeverity, message: string): IResourceMarker {
	return {
		resource,
		marker: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2, severity, message },
	};
}
