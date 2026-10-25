import { ChatAttachmentModel } from '../../../browser/attachments/chatAttachmentModel.js';
import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test, suite } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { isCancellationError } from '../../../../../../base/common/errors.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../../base/common/uri.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import type { ChatContextAttachment } from '../../../../../services/chat/common/chatContextService.js';
import { IChatPasteTargetService, type IChatPasteTarget } from '../../../browser/chat.js';
import { ChatDynamicVariableModel } from '../../../browser/attachments/chatDynamicVariables.js';
import { ChatPasteTargetService } from '../../../browser/attachments/chatPasteTargetService.js';
import { ChatWidgetPasteTarget } from '../../../browser/attachments/chatWidgetPasteTarget.js';
import { ChatInputEditorRegistry } from '../../../browser/widget/input/chatInputEditorRegistry.js';
import { SlashCommandCatalog } from '../../../common/slashCommands.js';
import { SkillSelectorCatalog } from '../../../common/skillSelectors.js';

function setup(resources: DisposableStore) {
	const owner = resources.add(new InstantiationService());
	let inputUri: URI | undefined;
	const routes = resources.add(new class extends ChatPasteTargetService {
		public override registerTarget(resource: URI, target: IChatPasteTarget) {
			inputUri = resource;
			return super.registerTarget(resource, target);
		}
	}());
	owner.registerInstance(IChatPasteTargetService, routes);
	const container = document.createElement('div');
	document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	const input = resources.add(new ChatInputEditorRegistry().create({
		container,
		placeholder: '',
		ariaLabel: 'Chat',
		slashCommands: new SlashCommandCatalog([], []),
		skills: new SkillSelectorCatalog(),
	}));
	const attachmentModel = resources.add(new ChatAttachmentModel());
	const references = resources.add(new ChatDynamicVariableModel(input, attachmentModel));
	const target = resources.add(owner.createInstance(ChatWidgetPasteTarget, input, references, attachmentModel));
	return { input, references, target, attachmentModel, routes, inputUri: inputUri! };
}

const attachment: ChatContextAttachment = { id: 'file', kind: 'file', name: 'file.ts', resolve: async () => ({ name: 'file.ts', content: 'Unsaved snapshot' }) };

test('Paste admission uses the existing reference model and returns its exact snapshot positions', async () => {
	using resources = new DisposableStore();
	const { input, references, target, attachmentModel, routes, inputUri } = setup(resources);
	using unbound = new InstantiationService();
	assert.throws(() => unbound.createInstance(ChatWidgetPasteTarget, input, references, attachmentModel), /Unknown service: chatPasteTargetService/u);
	const accepted = target.addAttachments([attachment]);
	assert.equal(routes.getTarget(inputUri), target);
	assert.equal(input.value, 'file.ts ');
	assert.deepEqual(accepted[0]!.reference, { start: 0, end: 7 });
	assert.equal(target.inlineReferences, references.variables);
	assert.equal(target.attachments[0]!.resolve, accepted[0]!.resolve);
	assert.equal(target.attachments[0]!.reference, undefined);
	assert.equal(attachmentModel.size, 1);
	assert.deepEqual(await accepted[0]!.resolve(), { name: 'file.ts', content: 'Unsaved snapshot' });
	target.removeAttachments([accepted[0]!.id]);
	assert.equal(input.value.trim(), '');
	assert.deepEqual(references.variables, []);
	target.dispose();
	assert.equal(routes.getTarget(inputUri), undefined);
	assert.throws(() => target.addAttachments([attachment]), isCancellationError);
});

test('Aborted, replaced and disposed paste targets cannot edit their borrowed composer', () => {
	using resources = new DisposableStore();
	const { input, target, routes, inputUri } = setup(resources);
	const controller = new AbortController();
	controller.abort();
	assert.throws(() => target.addAttachments([attachment], controller.signal), isCancellationError);
	using replacement = routes.registerTarget(inputUri, { attachments: [], inlineReferences: [], addAttachments: () => [], removeAttachments() { }, addInlineReference() { } });
	assert.throws(() => target.addAttachments([attachment]), isCancellationError);
	assert.throws(() => target.removeAttachments(['file']), isCancellationError);
	target.dispose();
	assert.ok(routes.getTarget(inputUri));
	assert.equal(input.value, '');
});

suite('Attachment batch admission', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('one manual batch edits text once and binds exact snapshot ranges at the replaced selection', async () => {
		using resources = new DisposableStore();
		const { input, references, target } = setup(resources);
		input.value = 'Review remove done';
		input.setSelection({ anchor: 7, active: 14 });
		let changes = 0;
		resources.add(input.onDidChange(() => { changes++; }));
		const second = { ...attachment, id: 'image', kind: 'image', name: 'two.png', resolve: async () => ({ name: 'two.png', content: 'Captured image' }) };
		const accepted = target.addAttachments([{ ...attachment, name: 'one.ts' }, second]);
		assert.equal(changes, 1);
		assert.equal(input.value, 'Review one.ts two.png done');
		assert.deepEqual(accepted.map(context => context.reference), [{ start: 7, end: 13 }, { start: 14, end: 21 }]);
		assert.deepEqual(accepted, references.variables);
		assert.deepEqual(input.getSelection(), { anchor: 22, active: 22 });
		assert.equal((await accepted[1]!.resolve()).content, 'Captured image');
	});

	test('a cancelled batch cannot insert any reference text', () => {
		using resources = new DisposableStore();
		const { input, target } = setup(resources);
		const controller = new AbortController();
		controller.abort();
		assert.throws(() => target.addAttachments([attachment, { ...attachment, id: 'another' }], controller.signal), isCancellationError);
		assert.equal(input.value, '');
		assert.deepEqual(target.attachments, []);
	});

	test('source admission registers one canonical capture and updates its existing reference', async () => {
		using resources = new DisposableStore();
		const { input, target, attachmentModel } = setup(resources);
		const first = { ...attachment, lifetime: 'source' as const, kind: 'mcpApp' };
		const accepted = target.addAttachments([first]);
		assert.equal(attachmentModel.attachments[0], first);
		assert.equal(accepted[0]!.resolve, first.resolve);
		const latest = { ...first, name: 'Current App', resolve: async () => ({ name: 'Current App', content: 'Latest capture' }) };
		target.addAttachments([latest]);
		assert.equal(input.value, 'Current App ');
		assert.equal(target.attachments[0], latest);
		assert.equal(target.inlineReferences.length, 1);
		assert.equal((await target.inlineReferences[0]!.resolve()).content, 'Latest capture');
	});

	test('one model replacement cannot republish older captures while its text projection removes another item', async () => {
		using resources = new DisposableStore();
		const { input, target, attachmentModel } = setup(resources);
		const [retained, removed] = target.addAttachments([attachment, { ...attachment, id: 'removed', name: 'removed.ts' }]);
		const updated = { ...attachment, id: retained!.id, name: 'updated.ts', resolve: async () => ({ name: 'updated.ts', content: 'New model capture' }) };
		const added = { ...attachment, id: 'added', name: 'added.ts' };
		let changes = 0;
		resources.add(attachmentModel.onDidChange(() => changes++));
		attachmentModel.updateContext([removed!.id], [updated, added]);
		assert.equal(changes, 1);
		assert.equal(attachmentModel.attachments[0], updated);
		assert.equal(attachmentModel.attachments[1], added);
		assert.deepEqual(target.inlineReferences.map(reference => reference.id), [updated.id, added.id]);
		for (const reference of target.inlineReferences) {
			assert.equal(input.value.slice(reference.reference!.start, reference.reference!.end), reference.name);
		}
		assert.equal((await target.inlineReferences[0]!.resolve()).content, 'New model capture');
	});
});
