import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { DocumentConversation, type DocumentConversationSelection } from '../../browser/documentConversation.js';

suite('Document conversation associations', () => {
	function fixture(values = new Map<string, string>()) {
		const selection = observableValue<DocumentConversationSelection | undefined>('selection', {
			scope: 'account-one', identity: 'unrelated', reference: { kind: 'conversation', id: 'unrelated' },
		});
		let drafts = 0;
		const storage = {
			get: (key: string) => values.get(key),
			store: (key: string, value: string) => { values.set(key, value); },
		} as unknown as IStorageService;
		const controller = new DocumentConversation('documents', selection, async (reference, signal) => {
			signal.throwIfAborted();
			const selected = reference ?? { kind: 'draft' as const, id: `draft-${++drafts}` };
			selection.set({ scope: selection.get()!.scope, identity: selected.id, reference: selected }, undefined);
			return true;
		}, storage);
		return { controller, selection, values };
	}

	test('an unassociated PDF opens a separate draft and returns to its own draft after unrelated navigation', async () => {
		const { controller, selection } = fixture();
		using owner = controller;
		const pdf = URI.file('/report.pdf');
		const signal = new AbortController().signal;
		await controller.open(pdf, signal);
		assert.deepEqual(selection.get()?.reference, { kind: 'draft', id: 'draft-1' });
		selection.set({ scope: 'account-one', identity: 'other', reference: { kind: 'conversation', id: 'other' } }, undefined);
		await controller.open(pdf, signal);
		assert.equal(selection.get()?.reference.id, 'draft-1');
		await controller.open(URI.file('/second.pdf'), signal);
		assert.equal(selection.get()?.reference.id, 'draft-2');
	});

	test('first-send materialization updates the document association and survives restoration', async () => {
		const first = fixture();
		const pdf = URI.file('/report.pdf');
		const signal = new AbortController().signal;
		await first.controller.open(pdf, signal);
		first.selection.set({ scope: 'account-one', identity: 'draft-1', reference: { kind: 'conversation', id: 'submitted' } }, undefined);
		first.controller.dispose();
		const restored = fixture(first.values);
		using owner = restored.controller;
		await restored.controller.open(pdf, signal);
		assert.equal(restored.selection.get()?.reference.id, 'submitted');
	});

	test('account switches and cancellation cannot select a previous account conversation', async () => {
		const { controller, selection, values } = fixture();
		using owner = controller;
		const pdf = URI.file('/report.pdf');
		await controller.open(pdf, new AbortController().signal);
		selection.set({ scope: 'account-two', identity: 'new-account', reference: { kind: 'draft', id: 'new-account' } }, undefined);
		await controller.open(pdf, new AbortController().signal);
		assert.equal(selection.get()?.reference.id, 'draft-2');
		const before = values.get('documents');
		await assert.rejects(controller.open(pdf, AbortSignal.abort()));
		assert.equal(values.get('documents'), before);
	});
});
