import assert from 'node:assert/strict';
import { test } from 'mocha';
import { findChangesEditorFileChange, getChangesEditorFileResource } from '../../browser/changesEditorLabels.js';
import type { IChangesFileItem } from '../../browser/changesViewRenderer.js';
import { createSessionFileChange } from '../../../../services/sessions/common/session.js';

test('deleted file identity matches both comparison sides but never another capture or conversation', () => {
	const change = {
		file: { path: 'src/deleted.ts', kind: 'deleted' },
		summary: { sessionId: 'session', threadId: 'thread', changeSetId: 'turn', revision: 7 },
	} as IChangesFileItem;
	const normalized = createSessionFileChange(change.summary, change.file);
	const resource = getChangesEditorFileResource(normalized);
	assert.equal(resource.toString(), 'ash-turn-diff:/turn/src/deleted.ts?session=session&thread=thread&revision=7');
	for (const side of ['', '&side=before', '&side=after']) {
		assert.equal(findChangesEditorFileChange(resource.with({ query: resource.query + side }), [normalized]), normalized);
	}
	for (const query of [
		'session=session&thread=thread&revision=6',
		'session=other&thread=thread&revision=7',
		'session=session&thread=other&revision=7',
		resource.query + '&side=unknown',
	]) {
		assert.equal(findChangesEditorFileChange(resource.with({ query }), [normalized]), undefined);
	}
	assert.equal(findChangesEditorFileChange(resource.with({ path: '/turn/src/other.ts' }), [normalized]), undefined);
});
