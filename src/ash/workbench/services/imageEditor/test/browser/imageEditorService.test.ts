import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ImageEditorService } from '../../browser/imageEditorService.js';
import type { ImageEditorOptions } from '../../common/imageEditorService.js';
import type { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();
class TestImageEditorService extends ImageEditorService {
	constructor() { super(); }
	lastSignal: AbortSignal | undefined;
	lastOptions: ImageEditorOptions | undefined;
	async capture(signal: AbortSignal, options?: ImageEditorOptions): Promise<VSBuffer | undefined> { this.lastSignal = signal; this.lastOptions = options; return undefined; }
}

test('image interactions are fenced by their exact provider and never fall back after retirement', async () => {
	using service = new TestImageEditorService();
	const owner = new AbortController();
	using registration = service.register({ id: 'test.editor', displayName: 'Test editor', default: true, accessibilityHelp: 'Image help', signal: owner.signal, resolve: async () => ({ html: '<p>Editor</p>' }) });
	assert.equal(service.available, true);
	const interaction = await service.resolve('screen', new AbortController().signal);
	assert.equal(interaction.signal.aborted, false);
	registration.dispose();
	assert.equal(owner.signal.aborted, false, 'A registry lease owns its cancellation without mutating the provider owner');
	assert.equal(interaction.signal.aborted, true);
	assert.equal(service.available, false);
	await assert.rejects(service.resolve('screen', new AbortController().signal), /Enable one default image editor/);
});

test('ambiguous defaults fail while an explicit editor remains available', async () => {
	using service = new TestImageEditorService();
	const signal = new AbortController().signal;
	using first = service.register({ id: 'first', displayName: 'First', default: true, accessibilityHelp: 'Image help', signal, resolve: async () => ({ html: 'first' }) });
	using second = service.register({ id: 'second', displayName: 'Second', default: true, accessibilityHelp: 'Image help', signal, resolve: async () => ({ html: 'second' }) });
	assert.equal(service.available, false);
	await assert.rejects(service.resolve('screen', signal), /Enable one default image editor/);
	assert.equal((await service.resolve('selection', signal, 'second')).view.html, 'second');
});


test('image destinations own draft cancellation and retire their only handler', async () => {
	using service = new TestImageEditorService();
	const draft = new AbortController();
	const request = new AbortController();
	using destination = service.registerAttachmentHandler(capture => capture(draft.signal).then(() => undefined));
	assert.throws(() => service.registerAttachmentHandler(async () => { }), /already registered/);
	await service.show({ editorId: 'other.image:editor' }, request.signal);
	assert.equal(service.lastOptions?.editorId, 'other.image:editor');
	assert.equal(service.lastSignal?.aborted, false);
	draft.abort();
	assert.equal(service.lastSignal?.aborted, true);
	destination.dispose();
	await assert.rejects(service.show({}, request.signal), /No image attachment target/);
});

test('retiring an attachment destination cancels its active producer without cancelling the caller', async () => {
	using service = new TestImageEditorService();
	const request = new AbortController();
	using destination = service.registerAttachmentHandler(capture => capture(new AbortController().signal).then(() => undefined));
	await service.show({}, request.signal);
	assert.equal(service.lastSignal?.aborted, false);
	destination.dispose();
	assert.equal(service.lastSignal?.aborted, true);
	assert.equal(request.signal.aborted, false);
});
