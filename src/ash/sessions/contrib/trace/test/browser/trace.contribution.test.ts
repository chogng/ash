import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { OpenAgentTraceCommandId } from '../../../../../workbench/contrib/trace/common/trace.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import '../../browser/trace.contribution.js';

suite('Sessions Execution Trace entry', () => {
	for (const turnId of ['child-turn', undefined]) {
		test(`opens the active child Thread at its recorded Turn ${String(turnId)}`, async () => {
			using services = new InstantiationService();
			const calls: unknown[][] = [];
			services.registerInstance(ICommandService, { executeCommand: async (...args: unknown[]) => { calls.push(args); } } as unknown as ICommandService);
			services.registerInstance(ISessionsService, {
				activeSelection: {
					kind: 'session', active: {
						threadId: 'child', session: {
							sessionId: 'session', agentTree: [{ threadId: 'root', currentTurnId: 'root-turn', children: [{ threadId: 'child', currentTurnId: turnId, children: [] }] }],
						}
					}
				}
			} as unknown as ISessionsService);
			await services.invokeFunction(CommandsRegistry.getCommand('sessions.trace.open')!);
			assert.deepEqual(calls, [
				['sessions.open.code'],
				[OpenAgentTraceCommandId, { sessionId: 'session', threadId: 'child', turnId }],
			]);
		});
	}

	test('keeps the import entry when there is no active Session', async () => {
		using services = new InstantiationService();
		const calls: unknown[][] = [];
		services.registerInstance(ICommandService, { executeCommand: async (...args: unknown[]) => { calls.push(args); } } as unknown as ICommandService);
		services.registerInstance(ISessionsService, { activeSelection: undefined } as unknown as ISessionsService);
		await services.invokeFunction(CommandsRegistry.getCommand('sessions.trace.open')!);
		assert.deepEqual(calls, [['sessions.open.code'], [OpenAgentTraceCommandId, undefined]]);
	});
});
