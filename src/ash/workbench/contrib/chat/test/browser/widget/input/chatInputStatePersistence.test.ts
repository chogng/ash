import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import {
	deserializeUntitledInputAttachments, deserializeUntitledInputState,
	serializeUntitledInputAttachments, serializeUntitledInputState,
} from '../../../../browser/widget/input/chatInputStatePersistence.js';

suite('Chat input state persistence codec', () => {
	test('image data stays out of input state and resource spellings survive a round trip', () => {
		const image = {
			id: 'image', kind: 'image', name: 'screen.png',
			content: `data:image/png;base64,${'A'.repeat(64 * 1024)}`,
			resource: 'file:///project/screen%20shot.png',
		};
		const draft = { mode: 'plan' as const, text: 'Inspect the screenshot', contexts: [image] };
		const state = serializeUntitledInputState(draft);
		const attachments = serializeUntitledInputAttachments(draft.contexts);
		assert.deepEqual(deserializeUntitledInputState(state), { ...draft, contexts: [] });
		assert.deepEqual(deserializeUntitledInputAttachments(attachments), [image]);
		assert.ok(state.length < 1024);
		assert.equal(state.includes(image.content), false);
		assert.equal(draft.contexts[0], image);
	});

	test('empty input state is explicit and malformed JSON never becomes a draft', () => {
		assert.equal(deserializeUntitledInputState(serializeUntitledInputState(undefined)), undefined);
		assert.deepEqual(deserializeUntitledInputAttachments(serializeUntitledInputAttachments([])), []);
		assert.throws(() => deserializeUntitledInputState('{unfinished'), SyntaxError);
		assert.throws(() => deserializeUntitledInputAttachments('{unfinished'), SyntaxError);
	});
});
