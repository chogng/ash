import assert from 'node:assert/strict';
import { suite, test, teardown } from 'mocha';
import { resetNlsResolver } from '../../../../../nls.js';
import { EditorInputSerializers } from '../../../editor/common/editorInputSerializer.js';
import { initializeTestLocalization } from '../../../localization/test/common/localizationTestUtils.js';
import { createUserSettingsEditorInput, UserSettingsResource } from '../../common/settingsEditorInput.js';

suite('User settings editor restoration', () => {
	teardown(() => resetNlsResolver());

	test('restores the editable settings input using the current locale', () => {
		resetNlsResolver();
		const input = createUserSettingsEditorInput();
		assert.equal(input.label, 'User Settings (JSON)');
		const saved = JSON.parse(JSON.stringify(EditorInputSerializers.serialize(input)));
		initializeTestLocalization('zh-CN');
		const restored = EditorInputSerializers.deserialize(saved);
		assert.deepEqual({ resource: restored.resource.toString(), languageId: restored.languageId, label: restored.label }, {
			resource: UserSettingsResource.toString(), languageId: 'jsonc', label: '用户设置（JSON）',
		});
	});

	test('rejects a different resource under the user settings editor identity', () => {
		const saved = EditorInputSerializers.serialize(createUserSettingsEditorInput());
		assert.throws(() => EditorInputSerializers.deserialize({ ...saved, value: 'file:///settings.json' }), TypeError);
	});
});
