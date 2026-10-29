import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { raceCancellation } from '../../../../../base/common/async.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationResolverService } from '../../../../services/configurationResolver/common/configurationResolver.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { TerminalCommandId } from '../../../terminal/common/terminal.js';
import { TerminalHasActiveInstanceContext } from '../../../terminal/common/terminalContextKey.js';

registerAction2(
	class SendSequenceAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.SendSequence,
				title: localize2('terminal.sendSequence.title', 'Terminal: Send Sequence'),
				f1: true,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				metadata: {
					description: localize(
						'terminal.sendSequence.description',
						'Send text or control characters to the active terminal without adding Enter.',
					),
					args: [
						{
							name: 'args',
							isOptional: true,
							schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
						},
					],
				},
			});
		}

		override async run(accessor: ServicesAccessor, args?: unknown): Promise<void> {
			let text: string | undefined;
			// Keybindings and extension commands are untyped inputs. Do not turn malformed
			// arguments into an unexpected prompt, especially when no terminal is running.
			if (args !== undefined) {
				if (
					!args ||
					typeof args !== 'object' ||
					Array.isArray(args) ||
					!('text' in args) ||
					typeof args.text !== 'string'
				) {
					throw new TypeError(
						localize(
							'terminal.sendSequence.invalidArgs',
							'Send Sequence requires an object with a string text property.',
						),
					);
				}
				text = args.text;
			}
			const terminals = accessor.get(ITerminalService);
			const instance = terminals.activeInstance;
			if (!instance || instance.isReadOnly || instance.state !== 'running') return;
			const processId = instance.processId;
			const workspace = accessor.get(IWorkspaceContextService);
			const folder = workspace.getWorkspace().folders.find(folder => folder.id === instance.dirId);
			const resolver = accessor.get(IConfigurationResolverService);
			using lifetime = new DisposableStore();
			const cancellation = lifetime.add(new CancellationTokenSource());
			const invalidate = (): void => cancellation.cancel();
			lifetime.add(instance.onDidChangeState(invalidate));
			lifetime.add(instance.onDidExit(invalidate));
			lifetime.add(terminals.onDidChangeActiveInstance(invalidate));
			lifetime.add(
				terminals.onDidDisposeInstance(disposed => {
					if (disposed === instance) invalidate();
				}),
			);
			lifetime.add(workspace.onDidChangeWorkspace(invalidate));
			const canSend = (): boolean =>
				!cancellation.token.isCancellationRequested &&
				terminals.activeInstance === instance &&
				terminals.instances.includes(instance) &&
				instance.processId === processId &&
				instance.state === 'running' &&
				!instance.isReadOnly;

			if (!text) {
				text = await accessor
					.get(IQuickInputService)
					.input(
						{
							title: localize('terminal.sendSequence.title', 'Terminal: Send Sequence'),
							placeHolder: localize(
								'terminal.sendSequence.placeholder',
								'Enter text or control characters (\\n, \\r, \\xNN)',
							),
						},
						cancellation.token,
					);
				if (!text || !canSend()) return;
				// Decode only prompted text. Command arguments already contain their intended
				// characters; decoding must not reinterpret a hex-encoded backslash.
				text = text.replace(/\\(?:n|r|x[0-9a-fA-F]{2})/g, escape =>
					escape === '\\n'
						? '\n'
						: escape === '\\r'
							? '\r'
							: String.fromCharCode(Number.parseInt(escape.slice(2), 16)),
				);
			}
			const shellEnvironment = instance.capabilities?.get(TerminalCapability.ShellEnvDetection)?.env;
			const resolution =
				shellEnvironment?.isTrusted && shellEnvironment.value !== undefined
					? resolver.resolveWithEnvironment(shellEnvironment.value, folder, text)
					: resolver.resolveAsync(folder, text);
			const resolved = await raceCancellation(resolution, cancellation.token);
			if (resolved === undefined || !canSend()) return;
			await instance.sendText(resolved, false);
			if (canSend()) instance.xterm?.focus();
		}
	},
);
