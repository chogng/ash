import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { localize } from '../../../../nls.js';
import { IDebugService, type IDebugSession, type IDebugVariable } from './debug.js';

export interface IDebugVisualization {
	readonly id: string;
	readonly name: string;
	visualize(signal: AbortSignal): Promise<{ content: string; languageId: string; }>;
}

export interface IDebugVisualizerService {
	getVisualizers(session: IDebugSession, variable: IDebugVariable): readonly IDebugVisualization[];
}

export const IDebugVisualizerService = createServiceIdentifier<IDebugVisualizerService>('debugVisualizerService');

/** Resolves bounded paused variable trees and command-backed Ash extension visualizers. */
export class DebugVisualizerService implements IDebugVisualizerService {
	constructor(
		@IDebugService private readonly debug: IDebugService,
		@IExtensionService private readonly extensions: IExtensionService,
		@ICommandService private readonly commands: ICommandService,
	) { }

	getVisualizers(session: IDebugSession, variable: IDebugVariable): readonly IDebugVisualization[] {
		const revision = session.inspectionRevision;
		const check = (signal: AbortSignal): void => {
			throwIfCancelled(signal);
			if (
				this.debug.getSession(session.id) !== session ||
				session.state !== 'stopped' ||
				session.inspectionRevision !== revision
			)
				throw new CancellationError();
		};
		const visualizers: IDebugVisualization[] = [
			{
				id: 'ash.debug.variableTree',
				name: localize('debug.variableTree', 'Variable tree'),
				visualize: async (signal) => {
					let remaining = 256;
					const visit = async (
						value: IDebugVariable,
						depth: number,
						ancestors: ReadonlySet<number>,
					): Promise<unknown> => {
						check(signal);
						const node: {
							name: string;
							value: string;
							type?: string;
							children?: unknown[];
							truncated?: boolean;
						} = {
							name: value.name.slice(0, 256),
							value: value.value.slice(0, 2048),
							...(value.type ? { type: value.type.slice(0, 256) } : {}),
						};
						if (!value.variablesReference || value.presentationHint?.lazy) return node;
						if (depth >= 4 || remaining <= 0 || ancestors.has(value.variablesReference))
							return { ...node, truncated: true };
						const path = new Set(ancestors).add(value.variablesReference);
						const children = await session.variables(value.variablesReference);
						check(signal);
						node.children = [];
						for (const child of children) {
							if (--remaining < 0) {
								node.truncated = true;
								break;
							}
							node.children.push(await visit(child, depth + 1, path));
						}
						return node;
					};
					const content = JSON.stringify(await visit(variable, 0, new Set()), null, 2);
					check(signal);
					return { content, languageId: 'json' };
				},
			},
		];
		for (const { description, value } of this.extensions.getExtensionPointContributions<
			readonly { id: string; title: string; command: string; type?: string; }[]
		>('debugVisualizers')) {
			for (const entry of value) {
				if (entry.type !== undefined && entry.type !== variable.type) continue;
				visualizers.push({
					id: `${description.id}:${entry.id}`,
					name: entry.title,
					visualize: async (signal) => {
						check(signal);
						const generation = this.extensions.currentCatalog.generation;
						const result: unknown = await this.commands.executeCommand(entry.command, {
							sessionId: session.id,
							threadId: session.threadId,
							frameId: this.debug.getViewModel().focusedStackFrame?.id,
							variable: { ...variable },
						});
						check(signal);
						if (generation !== this.extensions.currentCatalog.generation) throw new CancellationError();
						if (
							!result ||
							typeof result !== 'object' ||
							!('content' in result) ||
							typeof result.content !== 'string' ||
							result.content.length > 1_048_576 ||
							new TextEncoder().encode(result.content).byteLength > 1_048_576 ||
							('languageId' in result &&
								(typeof result.languageId !== 'string' || result.languageId.length > 128))
						)
							throw new TypeError(
								localize(
									'debug.visualizerResultInvalid',
									'A debug visualizer must return text content of at most 1 MiB and an optional language ID.',
								),
							);
						return {
							content: result.content,
							languageId: 'languageId' in result ? (result.languageId as string) : 'plaintext',
						};
					},
				});
			}
		}
		return visualizers;
	}
}
