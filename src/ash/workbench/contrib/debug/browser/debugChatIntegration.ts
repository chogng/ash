import { Disposable } from '../../../../base/common/lifecycle.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { localize } from '../../../../nls.js';
import {
	IChatContextPickService,
	type ChatContextAttachment,
	type ChatContextPick,
} from '../../../services/chat/common/chatContextService.js';
import { IDebugService, type IDebugSession, type IDebugVariable } from '../common/debug.js';

/** Offers immutable, explicitly selected Debug snapshots to Chat's existing composer. */
export class DebugChatContextContribution extends Disposable {
	constructor(
		@IDebugService private readonly debug: IDebugService,
		@IChatContextPickService contexts: IChatContextPickService,
	) {
		super();
		this._register(
			contexts.registerPicker({
				id: 'debug',
				label: localize('debug.chatContext', 'Debug context'),
				isEnabled: () => debug.sessions.some((session) => session.state === 'stopped'),
				providePicks: (query) => this.picks(query),
			}),
		);
	}

	private async picks(query: string): Promise<readonly ChatContextPick[]> {
		const session = this.debug.session;
		const frame = this.debug.getViewModel().focusedStackFrame;
		if (!session || session.state !== 'stopped' || !frame) return [];
		const revision = session.inspectionRevision;
		const scopes = await session.inspectFrame(frame.id);
		if (
			this.isDisposed ||
			this.debug.session !== session ||
			session.state !== 'stopped' ||
			session.inspectionRevision !== revision ||
			this.debug.getViewModel().focusedStackFrame !== frame
		)
			return [];
		const name = localize('debug.chatFrame', '{0}: {1}', session.name, frame.name);
		const location = `${frame.source?.path ?? frame.source?.name ?? frame.name}:${frame.lineNumber}:${frame.columnNumber}`;
		const variables = scopes.flatMap((scope) =>
			scope.variables.map((variable) => `${scope.scope.name}.${variable.name} = ${variable.value}`),
		);
		const content = [location, ...variables].join('\n').slice(0, 65536);
		const picks: ChatContextPick[] = [
			{
				label: name,
				detail: location,
				attachment: snapshot(session, `${revision}:frame:${frame.id}`, name, content),
			},
		];
		for (const scope of scopes)
			for (const variable of scope.variables)
				picks.push({
					label: variable.name,
					description: scope.scope.name,
					detail: variable.value.slice(0, 256),
					attachment: debugVariableContext(
						session,
						revision,
						variable,
						`${frame.id}:${scope.scope.variablesReference}`,
					),
				});
		const filter = query.toLocaleLowerCase();
		return picks
			.filter((pick) => `${pick.label} ${pick.description ?? ''}`.toLocaleLowerCase().includes(filter))
			.slice(0, 256);
	}
}

function debugVariableContext(
	session: IDebugSession,
	revision: number,
	variable: IDebugVariable,
	parent: string,
): ChatContextAttachment {
	if (session.state !== 'stopped' || session.inspectionRevision !== revision) throw new CancellationError();
	return snapshot(
		session,
		`${revision}:${parent}:${variable.name}`,
		variable.name,
		`${variable.name} = ${variable.value}${variable.type ? `\n${variable.type}` : ''}`,
	);
}

function snapshot(session: IDebugSession, key: string, name: string, content: string): ChatContextAttachment {
	return Object.freeze({
		id: `debug:${session.id}:${key}`,
		kind: 'debug',
		lifetime: 'submission' as const,
		name,
		resolve: async () => ({ name, content: content.slice(0, 65536) }),
	});
}
