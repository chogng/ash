import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { Position } from '../../../../common/core/position.js';
import { Range } from '../../../../common/core/range.js';
import { ReferencesModel } from '../../browser/referencesModel.js';

suite('Reference results', () => {
	test('groups targets by resource and preserves the first provider result after sorting', () => {
		const first = { uri: URI.file('/b.ts'), range: new Range(3, 1, 3, 10), targetSelectionRange: new Range(3, 4, 3, 8) };
		using model = new ReferencesModel([first, { uri: URI.file('/a.ts'), range: new Range(1, 1, 1, 4) }, { ...first }], 'Definitions');
		assert.deepEqual({ groups: model.groups.map(group => [group.uri.path, group.children.length]), first: model.firstReference()?.uri.path }, { groups: [['/a.ts', 1], ['/b.ts', 1]], first: '/b.ts' });
	});
	test('cycles across files in both directions', () => {
		using model = new ReferencesModel([
			{ uri: URI.file('/a.ts'), range: new Range(1, 1, 1, 4) },
			{ uri: URI.file('/b.ts'), range: new Range(2, 1, 2, 4) },
			{ uri: URI.file('/b.ts'), range: new Range(3, 1, 3, 4) },
		], 'References');
		const first = model.references[0]!;
		const last = model.references[2]!;
		assert.deepEqual([model.nextOrPreviousReference(last, true), model.nextOrPreviousReference(first, false)], [first, last]);
	});
	test('range changes notify once and change position lookup', () => {
		const uri = URI.file('/a.ts');
		using model = new ReferencesModel([{ uri, range: new Range(1, 1, 1, 4) }], 'References');
		const reference = model.firstReference()!;
		const changes: string[] = [];
		using listener = model.onDidChangeReferenceRange(value => changes.push(value.id));
		reference.range = new Range(2, 1, 2, 5);
		reference.range = new Range(2, 1, 2, 5);
		assert.deepEqual({ changes, old: model.referenceAt(uri, new Position(1, 2)), current: model.referenceAt(uri, new Position(2, 2)) }, { changes: [reference.id], old: undefined, current: reference });
	});
	test('nearest result favors a shared resource path before cursor distance', () => {
		using model = new ReferencesModel([
			{ uri: URI.file('/src/entry.ts'), range: new Range(50, 1, 50, 2) },
			{ uri: URI.file('/out/entry.js'), range: new Range(1, 1, 1, 2) },
		], 'Definitions');
		assert.equal(model.nearestReference(URI.file('/src/other.ts'), new Position(1, 1))?.uri.path, '/src/entry.ts');
	});
});
