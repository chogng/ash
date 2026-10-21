import assert from 'node:assert/strict';
import { test } from 'mocha';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IAccessibilityService } from '../../../../../platform/accessibility/common/accessibility.js';
import { DebugWatchAccessibilityAnnouncer } from '../../common/debugAccessibilityAnnouncer.js';

test('Watch announces only current changed successful values when explicitly enabled', () => {
	let enabled = true;
	const spoken: string[] = [];
	const configuration = { getValue: () => enabled } as unknown as IConfigurationService;
	const output = { alert: (text: string) => spoken.push(text) } as unknown as IAccessibilityService;
	const announcer = new DebugWatchAccessibilityAnnouncer(configuration, output);
	const value = (result: string) => [{ expression: 'answer', result: { result, variablesReference: 0 } }];
	announcer.announce('one', value('42'));
	announcer.announce('one', value('42'));
	announcer.announce('one', value('43'));
	announcer.announce('one', [{ expression: 'answer', error: 'stale frame' }]);
	enabled = false;
	announcer.announce('one', value('44'));
	enabled = true;
	announcer.announce('two', value('44'));
	assert.deepEqual(spoken, ['answer = 42', 'answer = 43', 'answer = 44']);
});
