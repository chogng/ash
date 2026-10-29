import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ImageEditorService } from '../../browser/imageEditorService.js';
import type { ImageEditorOptions } from '../../common/imageEditorService.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

ensureNoDisposablesAreLeakedInTestSuite();
class TestImageEditorService extends ImageEditorService {
	constructor() {
		super();
	}
	lastSignal: AbortSignal | undefined;
	lastOptions: ImageEditorOptions | undefined;
	result: VSBuffer | undefined;
	pending: DeferredPromise<VSBuffer | undefined> | undefined;
	async capture(signal: AbortSignal, options?: ImageEditorOptions): Promise<VSBuffer | undefined> {
		this.lastSignal = signal;
		this.lastOptions = options;
		return this.pending ? this.pending.p : this.result;
	}
}

test('image interactions are fenced by their exact provider and never fall back after retirement', async () => {
	using service = new TestImageEditorService();
	const owner = new AbortController();
	using registration = service.register({
		id: 'test.editor',
		displayName: 'Test editor',
		default: true,
		accessibilityHelp: 'Image help',
		signal: owner.signal,
		resolve: async () => ({ html: '<p>Editor</p>' }),
	});
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
	using first = service.register({
		id: 'first',
		displayName: 'First',
		default: true,
		accessibilityHelp: 'Image help',
		signal,
		resolve: async () => ({ html: 'first' }),
	});
	using second = service.register({
		id: 'second',
		displayName: 'Second',
		default: true,
		accessibilityHelp: 'Image help',
		signal,
		resolve: async () => ({ html: 'second' }),
	});
	assert.equal(service.available, false);
	await assert.rejects(service.resolve('screen', signal), /Enable one default image editor/);
	assert.equal((await service.resolve('selection', signal, 'second')).view.html, 'second');
});

test('standalone copy, save and cancellation need no chat destination', async () => {
	using service = new TestImageEditorService();
	const request = new AbortController();
	await service.show({ editorId: 'other.image:editor' }, request.signal);
	assert.equal(service.lastOptions?.editorId, 'other.image:editor');
	assert.equal(service.lastOptions?.defaultAction, 'copy');
	assert.equal(service.lastSignal?.aborted, false);
});

test('Add to Chat acquires its destination only after the standalone image is ready', async () => {
	using service = new TestImageEditorService();
	const request = new AbortController();
	service.pending = new DeferredPromise();
	const interaction = service.show({}, request.signal);
	let attachments = 0;
	using destination = service.registerAttachmentHandler(async capture => {
		attachments++;
		assert.equal(await capture(new AbortController().signal), image);
	});
	assert.throws(() => service.registerAttachmentHandler(async () => {}), /already registered/);
	assert.equal(attachments, 0);
	const image = VSBuffer.fromString('selected image');
	await service.pending.complete(image);
	await interaction;
	assert.equal(attachments, 1);
	assert.equal(request.signal.aborted, false);
});

test('retiring a chat destination does not cancel an independent screenshot', async () => {
	using service = new TestImageEditorService();
	service.pending = new DeferredPromise();
	using destination = service.registerAttachmentHandler(async () => {
		assert.fail('No attach action was chosen');
	});
	const interaction = service.show({}, new AbortController().signal);
	destination.dispose();
	assert.equal(service.lastSignal?.aborted, false);
	await service.pending.complete(undefined);
	await interaction;
	service.result = VSBuffer.fromString('image');
	service.pending = undefined;
	await assert.rejects(service.show({}, new AbortController().signal), /No image attachment target/);
});

test('cancelling an independent image request prevents a late attachment', async () => {
	using service = new TestImageEditorService();
	service.pending = new DeferredPromise();
	using destination = service.registerAttachmentHandler(async () => {
		assert.fail('Cancelled image must not attach');
	});
	const request = new AbortController();
	const interaction = service.show({}, request.signal);
	request.abort();
	await service.pending.complete(VSBuffer.fromString('late image'));
	await interaction;
});
