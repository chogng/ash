import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { registerOnboardingTryout } from '../../../onboarding/common/onboardingTryout.js';
import { prepareReleaseNotesMarkdown, releaseNotesTryoutId } from '../../browser/releaseNotesTryouts.js';

suite('ReleaseNotesTryouts', () => {
	test('only a registered ID becomes a clickable link', () => {
		using tryout = registerOnboardingTryout({
			id: 'test.releaseNotes.open', title: 'Open', description: 'Opens a test command',
			presentation: { kind: 'command', commandId: 'test.command' },
		});
		const markdown = '[Known](ash://tryout/test.releaseNotes.open) [Unknown](ash://tryout/test.releaseNotes.missing) [Malformed](ash://tryout/test.releaseNotes.open?command=other)';
		const prepared = prepareReleaseNotesMarkdown(markdown);
		assert.match(prepared, /\[Known\]\(#ash-release-tryout-test\.releaseNotes\.open\)/);
		assert.match(prepared, /\[Unknown\]\(ash:\/\/tryout\/test\.releaseNotes\.missing\)/);
		assert.match(prepared, /\[Malformed\]\(ash:\/\/tryout\/test\.releaseNotes\.open\?command=other\)/);
		assert.equal(releaseNotesTryoutId('#ash-release-tryout-test.releaseNotes.open'), 'test.releaseNotes.open');
		assert.equal(releaseNotesTryoutId('#ash-release-tryout-test.releaseNotes.missing'), undefined);
	});
});
