import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CanvasInput, type ICanvasService } from '../../../../../workbench/contrib/canvases/common/canvas.js';
import { SessionCanvasSerializer } from '../../electron-browser/sessionCanvasSerializer.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Session Canvas persistence', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('only admitted live identities round-trip and cold restoration cannot recreate a source', () => {
		const owner = {
			providerId: 'local-agent-host',
			session: URI.parse('ash-session:/source'),
			chat: URI.parse('ash-thread:/source'),
		};
		using input = new CanvasInput(
			{ ...owner, canvas: URI.parse('agent-host-canvas:/page') },
			{
				resource: URI.parse('agent-host-canvas:/page'),
				instanceId: 'board',
				title: 'Board',
				source: URI.parse('https://example.test/private?token=secret'),
			},
			{} as IEditorGroupsService,
		);
		let admitted = false;
		const serializer = new SessionCanvasSerializer({
			restoreCanvasInput: id => (admitted && id === input.serializationId ? input : undefined),
		} as ICanvasService);
		assert.equal(
			serializer.canSerialize(input),
			true,
			'intercept unadmitted inputs before the generic URI serializer',
		);
		assert.equal(serializer.serialize(input), null);
		admitted = true;
		const value = serializer.serialize(input);
		assert.deepEqual(value, { version: 1, id: input.serializationId });
		assert.equal(JSON.stringify(value).includes('secret'), false);
		assert.equal(serializer.deserialize(value), input);
		admitted = false;
		assert.throws(() => serializer.deserialize(value));
	});

	test('invalid versions, identities and extra fields are rejected before admission lookup', () => {
		let lookups = 0;
		const serializer = new SessionCanvasSerializer({
			restoreCanvasInput: () => {
				lookups++;
				return undefined;
			},
		} as unknown as ICanvasService);
		const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		for (const value of [
			undefined,
			null,
			[],
			id,
			{ version: 2, id },
			{ version: 1, id: 'canvas:/page' },
			{ version: 1, id, source: 'https://example.test' },
		]) {
			assert.throws(() => serializer.deserialize(value));
		}
		assert.equal(lookups, 0);
	});
});
