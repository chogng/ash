import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DesignDocumentModel, parseDesignDocument, serializeDesignDocument, type DesignShape } from '../../contrib/design/common/designDocument.js';
import { DesignViewport, hitTestDesignShapes } from '../../contrib/design/common/designGeometry.js';

test('Design documents round trip fractional coordinates and discard redo after a new edit', () => {
	using model = new DesignDocumentModel();
	const id = model.addShape('rectangle', { x: 0.25, y: -10.5 });
	const shape = { ...model.value.shapes[0], width: 1.25, rotation: 37 };
	model.updateShape(shape);
	const serialized = serializeDesignDocument(model.value);
	assert.deepEqual(parseDesignDocument(serialized), model.value);
	model.undo();
	model.redo();
	assert.equal(serializeDesignDocument(model.value), serialized);
	model.undo();
	model.removeShape(id);
	assert.deepEqual([model.value.shapes, model.canRedo], [[], false]);
	model.undo();
	assert.equal(model.value.shapes[0].width, 120);
});

test('Design files reject unsupported versions, duplicate identities and invalid geometry', () => {
	using model = new DesignDocumentModel();
	model.addShape('rectangle', { x: 0, y: 0 });
	const shape = model.value.shapes[0];
	for (const document of [
		{ version: 2, shapes: [] },
		{ version: 1, shapes: [shape, shape] },
		{ version: 1, shapes: [{ ...shape, width: 0 }] },
		{ version: 1, shapes: [{ ...shape, rotation: null }] },
		{ version: 1, shapes: [{ ...shape, fill: 'url(https://example.com)' }] },
		{ version: 1, shapes: [{ ...shape, kind: 'path' }] },
		{ version: 1, shapes: [], unknown: true },
	]) { assert.throws(() => parseDesignDocument(JSON.stringify(document)), TypeError); }
});

test('Design hit testing respects paint order, ellipse contours and rotation', () => {
	const rectangle: DesignShape = { id: 'back', kind: 'rectangle', x: -100, y: -100, width: 200, height: 200, rotation: 0, fill: '#808080' };
	const ellipse: DesignShape = { ...rectangle, id: 'front', kind: 'ellipse', x: 0, y: 0, width: 100, height: 40, rotation: 90 };
	assert.equal(hitTestDesignShapes([rectangle, ellipse], { x: 50, y: 60 })?.id, 'front');
	assert.equal(hitTestDesignShapes([rectangle, ellipse], { x: 68, y: 65 })?.id, 'back');
	assert.equal(hitTestDesignShapes([ellipse], { x: 0, y: 0 }), undefined);
	assert.equal(hitTestDesignShapes([{ ...ellipse, kind: 'rectangle' }], { x: 68, y: 65 })?.id, 'front');
});

test('Design camera keeps a fractional world point fixed across pan and zoom', () => {
	const camera = new DesignViewport();
	camera.panBy(123.5, -77.25);
	const point = { x: 211.25, y: 33.5 };
	const world = camera.toWorld(point);
	camera.zoomAt(point, 2);
	assert.deepEqual(camera.toWorld(point), world);
	camera.zoomAt(point, 100);
	assert.equal(camera.scale, 4);
	camera.zoomAt(point, 0.0001);
	assert.equal(camera.scale, 0.2);
	camera.reset();
	assert.deepEqual(camera.toWorld(point), point);
});
