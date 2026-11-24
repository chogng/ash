import { IAgentHostInputCompletionService } from '../../../../../../../platform/agentHost/common/agentService.js';
import { TrackedRangeStickiness } from '../../../../../../../editor/common/model.js';
import { Disposable, toDisposable } from '../../../../../../../base/common/lifecycle.js';
import { canceled } from '../../../../../../../base/common/errors.js';
import { CancellationTokenSource } from '../../../../../../../base/common/cancellation.js';
import { createUuid } from '../../../../../../../base/common/uuid.js';
import { basename, dirname, extUri } from '../../../../../../../base/common/resources.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { getNLSLanguage, localize } from '../../../../../../../nls.js';
import { ILanguageFeaturesService } from '../../../../../../../editor/common/services/languageFeatures.js';
import { EditorOption } from '../../../../../../../editor/common/config/editorOptions.js';
import { IWorkspaceContextService } from '../../../../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../../../../platform/files/common/files.js';
import { ISearchService } from '../../../../../../services/search/common/search.js';
import { QueryBuilder } from '../../../../../../services/search/common/queryBuilder.js';
import { IEditorGroupsService } from '../../../../../../services/editor/common/editorGroupsService.js';
import type { ChatContextAttachment } from '../../../../../../services/chat/common/chatContextService.js';
import { IChatSessionNavigationService } from '../../../../../../services/chat/common/chatSessionNavigationService.js';
import { IChatAttachmentResolveService } from '../../../attachments/chatAttachmentResolveService.js';
import type { IChatInputEditor } from '../chatInputEditorRegistry.js';
import { LanguageCompletionItemKind, type LanguageCompletionProviderCommandRequest, type LanguageCompletionProvider, type LanguageCompletionProviderRequest, type LanguageCompletionProviderResult } from '../../../../../../../editor/common/languages.js';
import { Position } from '../../../../../../../editor/common/core/position.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import { matchedCharacterIndices, type SlashCommandCatalog } from '../../../../common/slashCommands.js';
import type { SkillSelectorCatalog } from '../../../../common/skillSelectors.js';
import { createChatReferenceVariableEntry } from '../../../../common/attachments/chatVariableEntries.js';
import { computeCompletionRanges, getCompletionRangeWord } from './chatInputCompletionUtils.js';

export const CHAT_INPUT_LANGUAGE_ID = 'ash-chat-input';

/** Group order is shared by host and Workbench resource providers. */
export function chatResourceCompletionGroup(isDirectory: boolean) {
	return isDirectory
		? { order: 2, label: localize('chat.input.completion.folders', 'Folders') }
		: { order: 1, label: localize('chat.input.completion.files', 'Files') };
}

type ConversationCompletionDestination = { readonly sessionId: string; readonly threadId: string; }
	| { readonly providerId: string; readonly draft: { readonly id: string; readonly generation: number; }; };

interface ConversationCompletionSelection {
	readonly sessionId: string;
	readonly threadId: string;
	readonly destination: ConversationCompletionDestination;
	readonly mention: boolean;
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

export interface ChatConversationCompletionHost {
	getDestination(): ConversationCompletionDestination | undefined;
	accept(replacement: { readonly start: number; readonly end: number; }, attachment: ChatContextAttachment, signal: AbortSignal): Promise<void>;
}

function sameConversationDestination(left: ConversationCompletionDestination, right: ConversationCompletionDestination): boolean {
	if ('draft' in left) return 'draft' in right && left.providerId === right.providerId && left.draft.id === right.draft.id && left.draft.generation === right.draft.generation;
	return 'sessionId' in right && left.sessionId === right.sessionId && left.threadId === right.threadId;
}

function conversationCompletionTitle(title: string): string {
	return title.replace(/\s+/gu, ' ').trim() || localize('chat.input.completion.untitledConversation', 'Untitled conversation');
}

/** Resolves conversation references through the host catalog and the current draft owner. */
export class ChatConversationCompletions extends Disposable {
	constructor(
		input: IChatInputEditor,
		host: ChatConversationCompletionHost,
		@ILanguageFeaturesService features: ILanguageFeaturesService,
		@IChatSessionNavigationService navigation: IChatSessionNavigationService,
	) {
		super();
		const editor = input.codeEditor;
		const model = input.getModel?.();
		if (!editor || !model) return;

		const getSources = (destination: ConversationCompletionDestination, mention: boolean) => {
			const conversations = navigation.getConversationsForReference?.({ includeArchived: !mention }) ?? [];
			const providerId = 'draft' in destination ? destination.providerId
				: conversations.find(item => sameConversationDestination(item, destination))?.providerId;
			return providerId === undefined ? [] : conversations.filter(item => item.providerId === providerId);
		};
		const isCurrent = (resource: string | undefined, version: number) => !this.isDisposed && !model.isDisposed()
			&& resource === model.uri.toString() && version === model.getVersionId() && !editor.getOption(EditorOption.readOnly);
		this._register(features.completionProvider.register({
			id: `ash.chat.conversationReference.${createUuid()}`,
			languageIds: [CHAT_INPUT_LANGUAGE_ID],
			triggerCharacters: ['@', '#'],
			provideCompletions: request => {
				const destination = host.getDestination();
				if (!destination || !isCurrent(request.resource?.toString(), request.snapshot.version)) return undefined;
				const ranges = computeCompletionRanges(model, request.position, /[@#][^\s#@]*/u, true);
				const token = ranges && getCompletionRangeWord(ranges);
				if (!ranges || !token || token === '#') return undefined;
				const mention = token.startsWith('@');
				const input = token.toLowerCase();
				if (!mention && ('draft' in destination || (!'#session'.startsWith(input) && !input.startsWith('#session:')))) return undefined;
				const query = mention ? token.slice(1) : token.slice('#session:'.length);
				const { replace: range } = ranges;
				const start = model.getOffsetAt(range.getStartPosition());
				const end = model.getOffsetAt(range.getEndPosition());
				const text = model.getValueInRange(range);
				const sources = getSources(destination, mention).sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
				const items = sources.flatMap(source => {
					const current = sameConversationDestination(source, destination);
					if (mention && current) return [];
					const title = conversationCompletionTitle(source.title);
					const matches = matchedCharacterIndices(title, query);
					if (query && !matches.length) return [];
					const selection: ConversationCompletionSelection = { sessionId: source.sessionId, threadId: source.threadId, destination, mention, start, end, text };
					const updated = source.updatedAt === undefined ? undefined : new Date(source.updatedAt).toLocaleString(getNLSLanguage());
					const detail = current ? [localize('chat.input.completion.currentConversation', 'Current conversation'), updated].filter(Boolean).join(' · ')
						: mention ? source.providerLabel ?? updated : updated;
					return [{
						id: JSON.stringify([source.sessionId, source.threadId]), label: title, labelMatchIndices: matches,
						kind: LanguageCompletionItemKind.Reference, range, insertText: text, filterText: token,
						detail,
						group: mention ? { order: 0, label: localize('chat.input.completion.conversations', 'Conversations') } : undefined,
						command: { id: 'ash.chat.acceptConversationCompletion', title: localize('chat.context.add', 'Add context'), arguments: [selection] },
					}];
				});
				return { items: items.slice(0, mention ? 50 : 100), isIncomplete: true };
			},
			executeCompletionCommand: async (request, signal) => {
				const selection = request.command.arguments[0] as ConversationCompletionSelection;
				const destination = host.getDestination();
				if (signal.aborted || !isCurrent(request.resource?.toString(), request.snapshot.version)
					|| !destination || !sameConversationDestination(destination, selection.destination)
					|| request.snapshot.getText().slice(selection.start, selection.end) !== selection.text) return;
				const cursor = input.getSelection();
				if (cursor.anchor !== selection.end || cursor.active !== selection.end) return;
				const source = getSources(destination, selection.mention).find(item => item.sessionId === selection.sessionId && item.threadId === selection.threadId);
				if (!source) return;
				const attachment = createChatReferenceVariableEntry(source.sessionId, source.threadId, conversationCompletionTitle(source.title));
				await host.accept(selection, { ...attachment, id: `${attachment.id}:${createUuid()}` }, signal);
			},
		}));
	}
}

/** Adapts the Chat slash-command catalog to Stanza's completion contract. */
export function createChatCommandCompletionProvider(catalog: SlashCommandCatalog): LanguageCompletionProvider {
	return Object.freeze({
		id: 'ash.chat.commands',
		languageIds: Object.freeze([CHAT_INPUT_LANGUAGE_ID]),
		triggerCharacters: Object.freeze(['/']),
		provideCompletions: (request: LanguageCompletionProviderRequest) => {
			const lines = request.snapshot.getText().split('\n');
			const lineNumber = request.position.lineNumber;
			// Submission trims the draft. Suggestions must admit the same leading whitespace.
			if (lines.slice(0, lineNumber - 1).some(line => line.trim())) return emptyCompletionResult();
			const line = lines[lineNumber - 1] ?? '';
			const commandStart = line.search(/\S/u);
			const cursor = request.position.column - 1;
			const prefix = line.slice(commandStart, cursor);
			if (!prefix.startsWith('/') || /\s/.test(prefix)) return emptyCompletionResult();
			const query = prefix.slice(1);
			const matches = catalog.matching(query);
			// Weak name and description matches need an explicit choice before Enter can accept them.
			const selectFirst = !query || (matches[0]?.name.startsWith(query.toLowerCase()) ?? false);
			const commandEnd = commandStart + line.slice(commandStart).search(/\s|$/u);
			const existingCommand = query ? line.slice(commandStart + 1, commandEnd) : undefined;
			return Object.freeze({
				items: Object.freeze(matches.map((command, index) => {
					const end = command.name === existingCommand ? commandEnd : cursor;
					const replacementEnd = end + (/\s/u.test(line[end] ?? '') ? 1 : 0);
					const range = new Range(lineNumber, commandStart + 1, lineNumber, replacementEnd + 1);
					return Object.freeze({
						id: command.name,
						label: `/${command.name}`,
						labelMatchIndices: matchedCharacterIndices(command.name, query).map(position => position + 1),
						kind: LanguageCompletionItemKind.Function,
						range,
						insertText: `/${command.name} `,
						detail: command.description,
						detailMatchIndices: matchedCharacterIndices(command.description, query),
						filterText: `/${command.name}`,
						sortText: command.name,
						preselect: selectFirst && index === 0,
					});
				})),
				isIncomplete: true,
			});
		},
	});
}

function emptyCompletionResult(): LanguageCompletionProviderResult {
	return Object.freeze({ items: Object.freeze([]), isIncomplete: false });
}

interface ChatSkillCompletionOptions {
	readonly id: string;
	readonly languageId: string;
}

/** Adapts the Chat Skill catalog to the `$skill` completion contract. */
export function createChatSkillCompletionProvider(
	catalog: SkillSelectorCatalog,
	options: ChatSkillCompletionOptions = { id: 'ash.chat.skills', languageId: CHAT_INPUT_LANGUAGE_ID },
): LanguageCompletionProvider {
	return Object.freeze({
		id: options.id,
		languageIds: Object.freeze([options.languageId]),
		triggerCharacters: Object.freeze(['$']),
		provideCompletions: (request: LanguageCompletionProviderRequest) => {
			const line = request.snapshot.getText().split('\n')[request.position.lineNumber - 1] ?? '';
			const token = activeSkillToken(line, request.position.column - 1);
			if (!token) {
				return emptyCompletionResult();
			}
			const matches = catalog.matching(token.query);
			const range = Range.fromPositions(
				new Position(request.position.lineNumber, token.startColumn + 1),
				new Position(request.position.lineNumber, token.endColumn + 1),
			);
			return Object.freeze({
				items: Object.freeze(matches.map((skill, index) => Object.freeze({
					id: `${skill.source}:${skill.name}`,
					label: `$${skill.name}`,
					kind: LanguageCompletionItemKind.Reference,
					range,
					insertText: `$${skill.name} `,
					detail: skill.description,
					filterText: `$${skill.name}`,
					sortText: skill.name,
					...(index === 0 ? { preselect: true } : {}),
				}))),
				isIncomplete: true,
			});
		},
	});
}

function activeSkillToken(line: string, cursorColumn: number): { readonly query: string; readonly startColumn: number; readonly endColumn: number; } | undefined {
	if (cursorColumn > line.length) {
		return undefined;
	}
	const prefix = line.slice(0, cursorColumn);
	const startColumn = prefix.lastIndexOf('$');
	if (startColumn < 0 || (startColumn > 0 && !/\s/.test(line[startColumn - 1]!))) {
		return undefined;
	}
	const query = prefix.slice(startColumn + 1);
	if (!/^[a-z0-9-]*$/.test(query)) {
		return undefined;
	}
	const suffix = line.slice(cursorColumn);
	const suffixLength = suffix.search(/\s|$/);
	const tokenSuffix = suffix.slice(0, suffixLength);
	if (!/^[a-z0-9-]*$/.test(tokenSuffix)) {
		return undefined;
	}
	const tokenEnd = cursorColumn + tokenSuffix.length;
	return { query, startColumn, endColumn: tokenEnd + (/[ \t]/u.test(line[tokenEnd] ?? '') ? 1 : 0) };
}


/** Context suggestions bind accepted text to the originating composer's attachment owner. */
export class BuiltinDynamicCompletions extends Disposable {
	constructor(
		input: IChatInputEditor,
		host: {
			getAttachments(): readonly ChatContextAttachment[];
			getSessionId(): string | undefined;
			acquire(prepare: (signal: AbortSignal) => Promise<readonly ChatContextAttachment[]>, signal: AbortSignal): Promise<readonly ChatContextAttachment[]>;
		},
		@ILanguageFeaturesService features: ILanguageFeaturesService,
		@ISearchService search: ISearchService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IEditorGroupsService groups: IEditorGroupsService,
		@IFileService files: IFileService,
		@IChatAttachmentResolveService resolver: IChatAttachmentResolveService,
		@IAgentHostInputCompletionService hostCompletions: IAgentHostInputCompletionService,
	) {
		super();
		const model = input.getModel?.();
		if (!model) { return; }
		const lifetime = new AbortController();
		this._register(toDisposable(() => lifetime.abort()));
		const id = `ash.chat.context.${createUuid()}`;
		this._register(features.completionProvider.register({
			id,
			languageIds: [CHAT_INPUT_LANGUAGE_ID],
			triggerCharacters: ['@', '#'],
			provideCompletions: async (request, signal) => {
				if (request.resource?.toString() !== model.uri.toString() || lifetime.signal.aborted
					|| request.snapshot.version !== model.getVersionId()) { return undefined; }
				const text = request.snapshot.getText();
				const line = text.split('\n')[request.position.lineNumber - 1] ?? '';
				const ranges = computeCompletionRanges(model, request.position, /[@#][^\s@#]*/u, true);
				const token = ranges && getCompletionRangeWord(ranges);
				if (!token) { return emptyCompletionResult(); }
				// The connected host owns resource capture and stale-draft admission when advertised.
				if (hostCompletions.getTriggerCharacters(host.getSessionId()).includes(token[0]!)) return emptyCompletionResult();
				const query = token.slice(1);
				const startColumn = ranges!.replace.startColumn;
				const endColumn = ranges!.replace.endColumn;
				const separatorLength = /[ \t]/u.test(line[endColumn - 1] ?? '') ? 1 : 0;
				const range = new Range(request.position.lineNumber, startColumn, request.position.lineNumber, endColumn + separatorLength);
				const start = text.split('\n').slice(0, request.position.lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0) + startColumn - 1;
				const candidates: ContextCompletion[] = [];
				const seen = new Set<string>();
				const add = (candidate: ContextCompletion, matched = false): void => {
					if (seen.has(candidate.key) || !matched && !candidate.name.toLowerCase().includes(query.toLowerCase()) && !candidate.resource?.path.toLowerCase().includes(query.toLowerCase())) { return; }
					seen.add(candidate.key);
					candidates.push(candidate);
				};
				for (const attachment of host.getAttachments()) {
					if (attachment.kind !== 'toolSelection') { add({ key: `attachment:${attachment.id}`, name: attachment.name, attachmentId: attachment.id }); }
				}
				for (const editor of groups.groups.flatMap(group => group.inputs)) {
					if (files.hasProvider(editor.resource) || editor.initialText !== undefined || editor.resource.scheme === 'untitled') { add({ key: editor.resource.toString(), name: basename(editor.resource), resource: editor.resource }); }
				}
				const folders = workspace.getWorkspace().folders;
				for (const folder of folders) { add({ key: folder.uri.toString(), name: folder.name, resource: folder.uri, directory: true }); }
				if (query && folders.length) {
					const cancellation = new CancellationTokenSource();
					const combined = AbortSignal.any([signal, lifetime.signal]);
					const cancel = (): void => cancellation.cancel();
					combined.addEventListener('abort', cancel, { once: true });
					if (combined.aborted) { cancel(); }
					try {
						const found = await search.fileSearch(new QueryBuilder().file(folders.map(folder => folder.uri), { filePattern: query, sortByScore: true, maxResults: 50 }), cancellation.token);
						for (const file of found.results) {
							add({ key: file.resource.toString(), name: basename(file.resource), resource: file.resource }, true);
							let parent = dirname(file.resource);
							const folder = folders.find(folder => extUri.isEqualOrParent(parent, folder.uri));
							while (folder && extUri.isEqualOrParent(parent, folder.uri)) {
								add({ key: parent.toString(), name: basename(parent), resource: parent, directory: true });
								if (extUri.isEqual(parent, folder.uri)) { break; }
								parent = dirname(parent);
							}
						}
					} finally {
						combined.removeEventListener('abort', cancel);
						cancellation.dispose();
					}
				}
				if (signal.aborted || lifetime.signal.aborted) { throw canceled(); }
				return {
					items: candidates.slice(0, 50).map((candidate, index) => ({
						id: candidate.key, label: candidate.name, kind: candidate.directory ? LanguageCompletionItemKind.Folder : candidate.resource ? LanguageCompletionItemKind.File : LanguageCompletionItemKind.Reference,
						group: token.startsWith('@') ? candidate.resource ? chatResourceCompletionGroup(!!candidate.directory)
							: { order: 3, label: localize('chat.input.completion.attached', 'Attached context') } : undefined,
						detail: candidate.resource?.path, range, insertText: `${candidate.name} `,
						filterText: token, preselect: index === 0, sortText: String(index).padStart(3, '0'),
						command: { id: 'chat.attachContext', title: localize('chat.context.add', 'Add context'), arguments: [{ ...candidate, resource: candidate.resource?.toString(), start }] },
					})),
					isIncomplete: true,
				};
			},
			executeCompletionCommand: async (request: LanguageCompletionProviderCommandRequest, signal: AbortSignal) => {
				if (request.resource?.toString() !== model.uri.toString() || lifetime.signal.aborted) { throw canceled(); }
				const candidate = request.command.arguments[0] as Omit<ContextCompletion, 'resource'> & { resource?: string; start: number; };
				if (model.getVersionId() !== request.snapshot.version) { throw canceled(); }
				// Track only the accepted label so typing elsewhere can continue during the read.
				const [decoration] = model.deltaDecorations([], [{
					range: Range.fromPositions(model.getPositionAt(candidate.start), model.getPositionAt(candidate.start + candidate.name.length)),
					options: { description: 'chat-pending-context', stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
				}]);
				const current = (): Range => {
					if (this.isDisposed || model.isDisposed() || signal.aborted) { throw canceled(); }
					const range = model.getDecorationRange(decoration!);
					if (!range || model.getValueInRange(range) !== candidate.name) { throw canceled(); }
					return range;
				};
				try {
					await host.acquire(async draftSignal => {
						current();
						const source = candidate.attachmentId ? host.getAttachments().find(attachment => attachment.id === candidate.attachmentId) : undefined;
						const resource = candidate.resource ? URI.parse(candidate.resource) : undefined;
						const editor = resource ? groups.groups.flatMap(group => group.inputs).find(editor => extUri.isEqual(editor.resource, resource)) : undefined;
						let attachment = source;
						if (!attachment && editor) {
							attachment = await resolver.resolveEditorAttachContext(editor, draftSignal);
						} else if (!attachment && resource) {
							attachment = await resolver.resolveResourceAttachContext(resource, candidate.directory ?? false, draftSignal);
						}
						const range = current();
						if (!attachment || draftSignal.aborted) { throw canceled(); }
						return [{ ...attachment, name: candidate.name, reference: { start: model.getOffsetAt(range.getStartPosition()), end: model.getOffsetAt(range.getEndPosition()) } }];
					}, AbortSignal.any([signal, lifetime.signal]));
				} finally {
					if (!model.isDisposed()) { model.deltaDecorations([decoration!], []); }
				}
			},
		}));
	}
}

interface ContextCompletion {
	readonly key: string;
	readonly name: string;
	readonly resource?: URI;
	readonly directory?: boolean;
	readonly attachmentId?: string;
}
