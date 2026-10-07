import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Position } from '../../common/core/position.js';
import { Range } from '../../common/core/range.js';
import { createLineDocumentSnapshot, type LineSemanticAttributes } from '../../common/model/lineDocument.js';
import { TextModel } from '../../common/model/textModel.js';

test('LineDocumentSnapshot keeps rich semantics orthogonal to ordered logical lines', () => {
	const prose = 'Ash \uFFFC uses \uFFFC; see \uFFFC';
	const snapshot = createLineDocumentSnapshot({
		lines: [
			{ id: 'prose', text: prose },
			{ id: 'code-1', text: 'const answer = 42;' },
			{ id: 'code-2', text: 'return answer;' },
			{ id: 'figure', text: '\uFFFC' },
			{ id: 'caption', text: 'System architecture' },
		],
		marks: [{
			id: 'latin-font',
			kind: 'textStyle',
			from: { lineId: 'prose', offset: 0 },
			to: { lineId: 'prose', offset: 4 },
			attrs: { fontFamily: 'Times New Roman' },
		}],
		atoms: [
			{
				id: 'citation',
				kind: 'citation',
				position: { lineId: 'prose', offset: prose.indexOf('\uFFFC') },
				display: 'inline',
				attrs: { referenceIds: ['smith-2025'] },
			},
			{
				id: 'math',
				kind: 'math',
				position: { lineId: 'prose', offset: prose.indexOf('\uFFFC', prose.indexOf('\uFFFC') + 1) },
				display: 'inline',
				attrs: { source: 'E = mc^2', syntax: 'latex' },
			},
			{
				id: 'cross-reference',
				kind: 'crossReference',
				position: { lineId: 'prose', offset: prose.lastIndexOf('\uFFFC') },
				display: 'inline',
				attrs: { format: 'number' },
			},
			{ id: 'image', kind: 'image', position: { lineId: 'figure', offset: 0 }, display: 'block', attrs: { assetId: 'asset-1' } },
		],
		facets: [{ id: 'heading', kind: 'outline', lineId: 'prose', attrs: { level: 1, labelId: 'introduction' } }],
		regions: [{ id: 'code', kind: 'code', startLineId: 'code-1', endLineId: 'code-2', attrs: { languageId: 'typescript' } }],
		relations: [{
			id: 'caption-image',
			kind: 'caption',
			source: { kind: 'line', lineId: 'caption' },
			target: { kind: 'atom', atomId: 'image' },
			attrs: {},
		}, {
			id: 'cross-reference-image',
			kind: 'crossReference',
			source: { kind: 'atom', atomId: 'cross-reference' },
			target: { kind: 'atom', atomId: 'image' },
			attrs: { format: 'number' },
		}],
		metadata: { profile: 'academic' },
	});

	assert.equal(snapshot.getText(), `${prose}\nconst answer = 42;\nreturn answer;\n\uFFFC\nSystem architecture`);
	assert.equal(snapshot.lines.get('code-2')?.text, 'return answer;');
	assert.equal(snapshot.atoms.at({ lineId: 'prose', offset: prose.indexOf('\uFFFC') })?.kind, 'citation');
	assert.deepEqual(snapshot.facets.forLine('prose').map(facet => facet.kind), ['outline']);
	assert.equal(snapshot.regions.get('code')?.attrs.languageId, 'typescript');
	assert.equal(snapshot.relations.get('caption-image')?.target.kind, 'atom');
	assert.equal(snapshot.metadata.profile, 'academic');
});

test('LineDocumentSnapshot treats only CR and LF as physical line boundaries', () => {
	const snapshot = createLineDocumentSnapshot({ lines: [{ id: 'line', text: 'left\u2028right\u2029' }] });

	assert.equal(snapshot.getText(), 'left\u2028right\u2029');
	assert.throws(() => createLineDocumentSnapshot({ lines: [{ id: 'line', text: 'left\nright' }] }), /line terminator/);
});

test('LineDocumentSnapshot rejects detached atoms, atom marks, non-exclusive block atoms, and crossing regions', () => {
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	assert.throws(() => createLineDocumentSnapshot({
		lines: [{ id: 'line', text: '' }],
		metadata: cyclic as LineSemanticAttributes,
	}), /must not contain cycles/);
	assert.throws(() => createLineDocumentSnapshot({ lines: [{ id: 'line', text: '\uFFFC' }] }), /has no atom/);
	assert.throws(() => createLineDocumentSnapshot({
		lines: [{ id: 'line', text: 'a\uFFFCb' }],
		atoms: [{ id: 'image', kind: 'image', position: { lineId: 'line', offset: 1 }, display: 'block', attrs: {} }],
	}), /only content/);
	assert.throws(() => createLineDocumentSnapshot({
		lines: [{ id: 'line', text: 'a\uFFFCb' }],
		marks: [{ id: 'mark', kind: 'strong', from: { lineId: 'line', offset: 0 }, to: { lineId: 'line', offset: 3 }, attrs: {} }],
		atoms: [{ id: 'atom', kind: 'citation', position: { lineId: 'line', offset: 1 }, display: 'inline', attrs: {} }],
	}), /must not include atom/);
	assert.throws(() => createLineDocumentSnapshot({
		lines: ['a', 'b', 'c', 'd'].map(id => ({ id, text: id })),
		regions: [
			{ id: 'left', kind: 'code', startLineId: 'a', endLineId: 'c', attrs: {} },
			{ id: 'right', kind: 'quote', startLineId: 'b', endLineId: 'd', attrs: {} },
		],
	}), /cross/);
});

test('TextModel preserves logical line identity through edits and history without creating code blocks', () => {
	let nextLineId = 1;
	using model = new TextModel('a\nb', {
		lineIds: ['first', 'second'],
		lineIdGenerator: () => `inserted:${nextLineId++}`,
		metadata: { languageId: 'typescript' },
	});
	const initialSnapshot = model.lineDocument;
	assert.equal(model.lineDocument, initialSnapshot);

	model.pushEditOperations(null, [{ range: Range.fromPositions(new Position((0) + 1, (1) + 1), new Position((0) + 1, (1) + 1)), text: 'X\nY' }], () => null);
	assert.notEqual(model.lineDocument, initialSnapshot);
	assert.equal(initialSnapshot.getText(), 'a\nb');
	assert.deepEqual(model.lineDocument.lines.values.map(line => line.id), ['first', 'inserted:1', 'second']);
	assert.equal(model.lineDocument.metadata.languageId, 'typescript');
	assert.deepEqual(model.lineDocument.marks.values, []);
	assert.deepEqual(model.lineDocument.atoms.values, []);

	model.undo();
	assert.deepEqual(model.lineDocument.lines.values.map(line => line.id), ['first', 'second']);
	model.redo();
	assert.deepEqual(model.lineDocument.lines.values.map(line => line.id), ['first', 'inserted:1', 'second']);

	model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (2) + 1), new Position((1) + 1, (0) + 1)), text: '' }]);
	assert.deepEqual(model.lineDocument.lines.values.map(line => line.id), ['first', 'second']);
	assert.equal(model.getText(), 'aXY\nb');
	assert.deepEqual(model.linePointAt(new Position((1) + 1, (1) + 1)), { lineId: 'second', offset: 1 });
	assert.deepEqual(model.textPositionAt({ lineId: 'second', offset: 1 }), new Position((1) + 1, (1) + 1));
});

test('TextModel line points use the identified line length and reject invalid indexes', () => {
	using model = new TextModel('a\nlonger', { lineIds: ['short', 'long'] });
	assert.deepEqual(model.textPositionAt({ lineId: 'short', offset: 1 }), new Position(1, 2));
	assert.deepEqual(model.textPositionAt({ lineId: 'long', offset: 6 }), new Position(2, 7));
	assert.deepEqual(model.linePointAt(new Position(2, 7)), { lineId: 'long', offset: 6 });
	assert.throws(() => model.getLineId(-1), /outside/);
	assert.throws(() => model.getLineId(1.5), /outside/);
	assert.throws(() => model.textPositionAt({ lineId: 'short', offset: 2 }), /outside/);
});

test('TextModel leaves text and line identities unchanged when a line id generator fails', () => {
	let fail = true;
	let requests = 0;
	using model = new TextModel('a\nb', {
		lineIds: ['first', 'second'],
		lineIdGenerator: () => {
			requests += 1;
			if (fail && requests === 2) throw new Error('line id unavailable');
			return `generated:${requests}`;
		},
	});
	const snapshot = model.lineDocument;
	const events: unknown[] = [];
	using listener = model.onDidChangeContent(change => events.push(change));
	const edit = { range: new Range(1, 2, 1, 2), text: '\n\n' };

	assert.throws(() => model.applyOperations([edit]), /line id unavailable/);
	assert.deepEqual({
		text: model.getText(),
		version: model.getVersionId(),
		lineIds: model.lineDocument.lines.values.map(line => line.id),
		snapshotRetained: model.lineDocument === snapshot,
		canUndo: model.canUndo(),
		eventCount: events.length,
	}, {
		text: 'a\nb',
		version: 1,
		lineIds: ['first', 'second'],
		snapshotRetained: true,
		canUndo: false,
		eventCount: 0,
	});

	fail = false;
	requests = 0;
	model.applyOperations([edit]);
	assert.deepEqual({
		text: model.getText(),
		lineIds: model.lineDocument.lines.values.map(line => line.id),
		version: model.getVersionId(),
	}, {
		text: 'a\n\n\nb',
		lineIds: ['first', 'generated:1', 'generated:2', 'second'],
		version: 2,
	});
});

test('TextModel keeps undo history when reset cannot allocate line identities', () => {
	let fail = true;
	using model = new TextModel('a\nb', {
		lineIds: ['first', 'second'],
		lineIdGenerator: () => {
			if (fail) throw new Error('reset line id unavailable');
			return 'inserted';
		},
	});
	model.applyOperations([{ range: new Range(1, 2, 1, 2), text: '!' }]);
	const version = model.getVersionId();
	const snapshot = model.lineDocument;
	const events: unknown[] = [];
	using listener = model.onDidChangeContent(change => events.push(change));

	assert.throws(() => model.reset('a!\n\nb'), /reset line id unavailable/);
	assert.deepEqual({
		text: model.getText(),
		version: model.getVersionId(),
		lineIds: model.lineDocument.lines.values.map(line => line.id),
		snapshotRetained: model.lineDocument === snapshot,
		canUndo: model.canUndo(),
		eventCount: events.length,
	}, {
		text: 'a!\nb',
		version,
		lineIds: ['first', 'second'],
		snapshotRetained: true,
		canUndo: true,
		eventCount: 0,
	});

	fail = false;
	model.undo();
	assert.equal(model.getText(), 'a\nb');
});
