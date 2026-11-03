import type { ClaudeHookImportCommand } from '../../../../../platform/agentHost/common/appServerApi.js';

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function plainArgument(value: unknown): value is string {
	return typeof value === 'string' && !!value.trim()
		&& !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value)
		&& !/\$\{?CLAUDE_(?:PROJECT_DIR|PLUGIN_ROOT|PLUGIN_DATA|ENV_FILE)/u.test(value);
}

/** Convert only synchronous, unconditional POSIX commands into disabled user declarations. */
export function parseClaudeHooks(settings: unknown, idPrefix: string): { readonly toml: string; readonly commands: readonly ClaudeHookImportCommand[]; readonly skipped: number; } {
	const root = record(settings);
	const events = record(root?.hooks);
	if (!events || root?.disableAllHooks === true) return { toml: '', commands: [], skipped: 0 };
	const commands: ClaudeHookImportCommand[] = [];
	let skipped = 0;
	for (const [event, groups] of Object.entries(events)) {
		if (event !== 'PreToolUse' || !Array.isArray(groups)) {
			skipped++;
			continue;
		}
		for (const value of groups) {
			const group = record(value);
			if (!group || !Array.isArray(group.hooks)
				|| Object.keys(group).some(key => key !== 'matcher' && key !== 'hooks')
				|| (group.matcher !== undefined && group.matcher !== '' && group.matcher !== '*')) {
				skipped++;
				continue;
			}
			for (const item of group.hooks) {
				const hook = record(item);
				const timeout = hook?.timeout === undefined ? 600 : hook.timeout;
				if (commands.length >= 128 || !hook || hook.type !== 'command' || !plainArgument(hook.command)
					|| (hook.args !== undefined && (!Array.isArray(hook.args) || !hook.args.every(plainArgument)))
					|| Object.keys(hook).some(key => !['type', 'command', 'args', 'timeout', 'async'].includes(key))
					|| (hook.async !== undefined && hook.async !== false)
					|| typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
					skipped++;
					continue;
				}
				commands.push({
					id: `user:hook:claude-${idPrefix}-${String(commands.length + 1).padStart(3, '0')}`, program: Array.isArray(hook.args) ? hook.command : '/bin/sh',
					args: Array.isArray(hook.args) ? hook.args : ['-c', hook.command], timeoutSeconds: timeout
				});
			}
		}
	}
	return {
		skipped,
		commands,
		toml: commands.map(({ id: hookId, program, args, timeoutSeconds }) => {
			const id = JSON.stringify(hookId);
			return [
				`[hooks.hooks.${id}]`,
				`id = ${id}`,
				'event = "preToolUse"',
				'enablement = "disabled"',
				`claudePreToolUse = { timeoutSeconds = ${timeoutSeconds} }`,
				`action = { type = "process", program = ${JSON.stringify(program)}, args = ${JSON.stringify(args)} }`,
			].join('\n');
		}).join('\n\n'),
	};
}
