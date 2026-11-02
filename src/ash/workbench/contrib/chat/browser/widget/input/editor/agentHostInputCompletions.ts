import { raceCancellationError } from '../../../../../../../base/common/async.js';
import { CancellationError } from '../../../../../../../base/common/errors.js';
import { toDisposable } from '../../../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../../../base/common/uri.js';
import { localize } from '../../../../../../../nls.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import { LanguageCompletionItemKind, type LanguageCompletionProviderRequest, type LanguageCompletionProviderResult } from '../../../../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../../../../editor/common/services/languageFeatures.js';
import type { ITextModel } from '../../../../../../../editor/common/model.js';
import { IAgentHostInputCompletionService } from '../../../../../../../platform/agentHost/common/agentService.js';
import type { AgentHostInputCompletionItem } from '../../../../../../../platform/agentHost/common/agent.js';
import type { SkillReference } from '../../../../../../../platform/agentHost/common/appServerApi.js';
import { IWorkspaceContextService, type IWorkspace } from '../../../../../../../platform/workspace/common/workspace.js';
import { AgentHostInputCompletionsBase } from './agentHostInputCompletionsBase.js';

interface AcceptedCompletion {
	readonly item: AgentHostInputCompletionItem;
	readonly text: string;
	readonly workspace: IWorkspace;
	readonly lifecycle: AbortSignal;
}

/** Composer-owned admission; the provider never keeps a second attachment inventory. */
export interface AgentHostInputCompletionHost {
	currentLifecycle(): AbortSignal;
	getContext(): { readonly sessionId?: string; readonly threadId?: string; };
	isEnabled(): boolean;
	acceptSkill(skill: SkillReference): void;
	acceptResource(resource: URI, isDirectory: boolean, replacement: { readonly start: number; readonly end: number; }, signal: AbortSignal): Promise<void>;
}

/** Maps host candidates to editor edits, then admits captured resources or pinned skills. */
export class AgentHostInputCompletions extends AgentHostInputCompletionsBase {
	private readonly candidates = new Map<string, AcceptedCompletion>();
	private generation = 0;
	private registered = false;
	private workspaceLifetime = new AbortController();

	constructor(
		model: ITextModel,
		private readonly host: AgentHostInputCompletionHost,
		@ILanguageFeaturesService languageFeatures: ILanguageFeaturesService,
		@IAgentHostInputCompletionService private readonly completions: IAgentHostInputCompletionService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
	) {
		super(model, () => host.currentLifecycle(), () => host.isEnabled(), languageFeatures);
		const retire = () => {
			this.workspaceLifetime.abort();
			this.workspaceLifetime = new AbortController();
			this.candidates.clear();
			if (this.registered) this.register();
		};
		this._register(workspace.onDidChangeWorkspace(retire));
		this._register(completions.onDidChangeConnection(retire));
		this._register(toDisposable(() => this.workspaceLifetime.abort()));
	}

	public register(): void {
		this.registered = true;
		const service = this.completions;
		const host = this.host;
		this.registerProvider({
			get triggerCharacters() { return service.getTriggerCharacters(host.getContext().sessionId); },
			provideCompletions: (request, signal) => this.provideCandidates(request, signal),
			executeCompletionCommand: async (request, signal) => {
				const id = request.command.arguments[0];
				const candidate = typeof id === 'string' ? this.candidates.get(id) : undefined;
				this.candidates.clear();
				if (!candidate || candidate.workspace !== this.workspace.getWorkspace() || candidate.lifecycle !== this.currentLifecycle()
					|| candidate.text !== request.snapshot.getText()) throw new CancellationError();
				const value = candidate.item.value;
				if (value.kind === 'skill') this.host.acceptSkill(value.skill);
				if (value.kind === 'resource') await this.host.acceptResource(value.resource, value.isDirectory, candidate.item, AbortSignal.any([signal, this.workspaceLifetime.signal]));
			},
		});
	}

	private async provideCandidates(request: LanguageCompletionProviderRequest, signal: AbortSignal): Promise<LanguageCompletionProviderResult> {
		signal = AbortSignal.any([signal, this.workspaceLifetime.signal]);
		const text = request.snapshot.getText();
		const lines = text.split('\n');
		const offset = lines.slice(0, request.position.lineNumber - 1).reduce((offset, line) => offset + line.length + 1, 0) + request.position.column - 1;
		const workspace = this.workspace.getWorkspace();
		const lifecycle = this.currentLifecycle();
		const generation = ++this.generation;
		const found = await raceCancellationError(this.completions.complete({ text, offset, ...this.host.getContext(), directories: workspace.folders.map(folder => ({ resource: folder.uri, target: { type: 'workspace', dirId: folder.id } })) }, signal), signal);
		if (signal.aborted || workspace !== this.workspace.getWorkspace() || generation !== this.generation) throw new CancellationError();
		this.candidates.clear();
		return {
			items: found.map((item, index) => {
				const id = `${generation}:${index}`;
				const value = item.value;
				// A resource is replaced only after capture succeeds. Failed reads preserve the query.
				const insertText = value.kind === 'resource' ? text.slice(item.start, item.end) : item.insertText;
				this.candidates.set(id, { item, text: text.slice(0, item.start) + insertText + text.slice(item.end), workspace, lifecycle });
				return {
					id, label: item.label, insertText,
					kind: value.kind === 'command' ? LanguageCompletionItemKind.Function : value.kind === 'skill' ? LanguageCompletionItemKind.Reference : value.isDirectory ? LanguageCompletionItemKind.Folder : LanguageCompletionItemKind.File,
					range: Range.fromPositions(this.model.getPositionAt(item.start), this.model.getPositionAt(item.end)),
					filterText: text.slice(item.start, offset), detail: item.detail, sortText: index.toString().padStart(6, '0'), preselect: item.preselect,
					...(value.kind === 'command' ? {} : { command: { id: 'ash.chat.acceptHostInputCompletion', title: localize('chat.context.add', 'Add context'), arguments: [id] } }),
				};
			}),
			isIncomplete: true,
		};
	}
}
