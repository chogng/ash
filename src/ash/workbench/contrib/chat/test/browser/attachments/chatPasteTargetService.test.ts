import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../../base/common/uri.js';
import type { IChatPasteTarget } from '../../../browser/chat.js';
import { ChatPasteTargetService } from '../../../browser/attachments/chatPasteTargetService.js';

function target(): IChatPasteTarget {
	return { attachments: [], inlineReferences: [], addAttachments: () => [], removeAttachments() { }, addInlineReference() { } };
}

test('Paste routing keeps distinct inputs and a replaced registration survives its predecessor disposal', () => {
	using service = new ChatPasteTargetService();
	const firstUri = URI.parse('ash-chat-input:/first');
	const secondUri = URI.parse('ash-chat-input:/second');
	const first = target();
	const second = target();
	const replacement = target();
	const original = service.registerTarget(firstUri, first);
	using other = service.registerTarget(secondUri, second);
	using replaced = service.registerTarget(firstUri, replacement);
	original.dispose();
	assert.equal(service.getTarget(firstUri), replacement);
	assert.equal(service.getTarget(secondUri), second);
	replaced.dispose();
	assert.equal(service.getTarget(firstUri), undefined);
	assert.equal(service.getTarget(secondUri), second);
});

test('Disposing paste routing retires borrowed targets and rejects new registration', () => {
	const service = new ChatPasteTargetService();
	const resource = URI.parse('ash-chat-input:/input');
	using registration = service.registerTarget(resource, target());
	service.dispose();
	assert.equal(service.getTarget(resource), undefined);
	assert.throws(() => service.registerTarget(resource, target()), /already disposed/u);
});
