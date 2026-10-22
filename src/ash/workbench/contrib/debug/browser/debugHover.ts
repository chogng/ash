import { CancellationError } from '../../../../base/common/errors.js';
import type { IDebugSession, IDebugStackFrame, IDebugVariable } from '../common/debug.js';

/** Reads a name chain from one paused frame; it never evaluates arbitrary source text. */
export async function findExpressionInStackFrame(
	session: IDebugSession,
	frame: IDebugStackFrame,
	names: readonly string[],
	signal: AbortSignal,
): Promise<IDebugVariable | undefined> {
	const revision = session.inspectionRevision;
	const check = (): void => {
		if (signal.aborted || session.state !== 'stopped' || session.inspectionRevision !== revision) throw new CancellationError();
	};
	check();
	const scopes = await session.inspectFrame(frame.id);
	check();
	let values = scopes.flatMap((scope) => scope.variables);
	let value: IDebugVariable | undefined;
	for (let index = 0; index < names.length; index++) {
		value = values.find((candidate) => candidate.name === names[index]);
		if (!value || index === names.length - 1) break;
		if (!value.variablesReference || value.presentationHint?.lazy) return undefined;
		values = [...(await session.variables(value.variablesReference))];
		check();
	}
	return value;
}
