import assert from 'node:assert/strict';
import { test } from 'mocha';
import { parseClaudeHooks } from '../../../../common/promptSyntax/hookClaudeCompat.js';

test('Claude migration preserves supported commands in disabled declarations and skips unmatched formats', () => {
	const command = 'printf "%s" "$HOME"';
	const settings = {
		hooks: {
			PreToolUse: [
				{ matcher: '*', hooks: [{ type: 'command', command, timeout: 4 }] },
				{ hooks: [{ type: 'command', command: 'policy-hook', args: ['a b', '$HOME'] }] },
				{ matcher: 'Bash', hooks: [{ type: 'command', command }] },
				{ hooks: [{ type: 'command', command, async: true }, { type: 'command', command, timeout: 0 }] },
			],
			Stop: [{ hooks: [{ type: 'command', command }] }],
		},
	};
	const result = parseClaudeHooks(settings, 'fixture');
	assert.equal(result.skipped, 4);
	assert.equal(result.commands[1]?.program, 'policy-hook');
	assert.deepEqual(result.commands[1]?.args, ['a b', '$HOME']);
	assert.match(result.toml, /^\[hooks\.hooks\."user:hook:claude-fixture-001"\]/u);
	assert.ok(result.toml.includes('enablement = "disabled"'));
	assert.ok(result.toml.includes('timeoutSeconds = 4'));
	assert.ok(result.toml.includes(`args = ${JSON.stringify(['-c', command])}`));
	assert.deepEqual(parseClaudeHooks({ ...settings, disableAllHooks: true }, 'fixture'), { toml: '', commands: [], skipped: 0 });
});
