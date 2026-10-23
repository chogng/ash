import assert from 'node:assert/strict';
import { test } from 'mocha';
import { validateImageViewRequest, validateImageViewCompletion, validateImageViewImage, validateImageViewInitialization, validateImageViewPermissionAction } from '../../common/imageView.js';

function image(): Uint8Array {
	const bytes = new Uint8Array(33);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
	const header = new DataView(bytes.buffer);
	header.setUint32(16, 800); header.setUint32(20, 600);
	return bytes;
}
function presentation(source = 'screen') {
	return { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Test image', source, html: '<p>Test view</p>', input: { state: { own: true } } };
}

test('native image presentation accepts opaque client data and cannot select a host window or path', () => {
	const request = presentation();
	assert.equal(validateImageViewRequest(request), request);
	for (const invalid of [{ ...request, windowId: 3 }, { ...request, filePath: '/tmp/private' }, { ...request, source: 'editorModel' }, { ...request, input: { code: () => { } } }, { ...request, input: { state: 'x'.repeat(256 * 1024 + 1) } }]) assert.throws(() => validateImageViewRequest(invalid));
	const png = image();
	assert.equal(validateImageViewImage(png), png);
	new DataView(png.buffer).setUint32(16, 0xffffffff);
	assert.throws(() => validateImageViewImage(png), /too large/);
});

test('screen initialization requires bounded PNG pixels and content initialization excludes them', () => {
	const initial = { image: image(), presentation: presentation(), locale: 'zh-CN', bundles: { ash: { title: '图片' } } };
	assert.equal(validateImageViewInitialization(initial), initial);
	for (const invalid of [{ ...initial, windowId: 3 }, { ...initial, locale: '../invalid' }, { ...initial, image: new Uint8Array(100) }, { ...initial, bundles: { ash: { title: 3 } } }]) assert.throws(() => validateImageViewInitialization(invalid));
	const content = { ...initial, presentation: presentation('content'), image: new Uint8Array() };
	assert.equal(validateImageViewInitialization(content), content);
	assert.throws(() => validateImageViewInitialization({ ...content, image: image() }), /cannot include screen pixels/);
});

test('image view output is finite and cannot choose arbitrary native operations', () => {
	assert.equal(validateImageViewCompletion({ kind: 'copy', image: image() }).kind, 'copy');
	assert.deepEqual(validateImageViewCompletion({ kind: 'retake' }), { kind: 'retake' });
	assert.deepEqual(validateImageViewCompletion({ kind: 'error', message: 'Rendering failed' }), { kind: 'error', message: 'Rendering failed' });
	for (const invalid of [{ kind: 'save', image: image(), filePath: '/tmp/private' }, { kind: 'execute', command: 'anything' }, { kind: 'error', message: 'x'.repeat(4097) }, { kind: 'copy', image: new Uint8Array(100) }]) assert.throws(() => validateImageViewCompletion(invalid));
});


test('permission guide can only act on the host-selected application bundle', () => {
	for (const action of ['settings', 'drag', 'copyPath', 'retry', 'cancel']) assert.equal(validateImageViewPermissionAction(action), action);
	for (const invalid of [{ action: 'drag', path: '/tmp/other.app' }, 'grant', 'restart', undefined]) assert.throws(() => validateImageViewPermissionAction(invalid));
	const permission = { applicationName: 'Ash.app', icon: image() };
	const initial = { permission, image: new Uint8Array(), presentation: presentation(), locale: 'zh-CN', bundles: { ash: {} } };
	assert.equal(validateImageViewInitialization(initial), initial);
	for (const invalid of [{ ...initial, path: '/tmp/other.app' }, { ...initial, image: image() }, { ...initial, permission: { ...permission, path: '/tmp/other.app' } }, { ...initial, permission: { ...permission, icon: new Uint8Array() } }, { ...initial, permission: { ...permission, applicationName: '' } }, { ...initial, presentation: presentation('content') }]) assert.throws(() => validateImageViewInitialization(invalid));
});
