import type { Event } from '../../../../../base/common/event.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import type { IAccessibleViewImplementation } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { ChatToolCallBinding } from '../../../../../platform/agentHost/common/agent.js';
import type { ChatContentPart } from '../../../../services/chat/common/chatService.js';
import { formatChatMessageTime, formatLoadedSkillReason, type IChatListItem } from '../../common/model/chatViewModel.js';
import { reviveChatTreeData, type IChatResponseProgressFileTreeData } from '../../common/chatService/chatService.js';
import { ChatAccessibilityProvider } from './chatAccessibilityProvider.js';
import { renderChatMarkdownPlaintext, renderChatRichContentText } from '../widget/chatMarkdownRichContent.js';

interface ChatResponseSource {
	readonly getItems: () => readonly IChatListItem[];
	readonly getFocusedElement: () => HTMLElement | undefined;
	readonly onDidChangeContent: Event<void>;
}

/** Reads the owning transcript projection, including content outside rendered editor viewports. */
export class ChatResponseAccessibleView implements IAccessibleViewImplementation {
	public readonly priority = 100;
	public readonly name = `chatTranscript-${AccessibleViewType.View}-${createUuid()}`;
	public readonly type = AccessibleViewType.View;
	private readonly labels = new ChatAccessibilityProvider();

	constructor(
		private readonly source: ChatResponseSource,
		private readonly showAgentReplyTimestamps = () => true,
	) { }

	public getProvider(): AccessibleContentProvider | undefined {
		const focused = this.source.getFocusedElement();
		if (!focused) { return undefined; }
		const provider = new AccessibleContentProvider(
			AccessibleViewProviderId.SessionsChat,
			{ type: AccessibleViewType.View },
			() => this.source.getItems().map(item => this.messageText(item)).join('\n\n'),
			() => { if (focused.isConnected) { focused.focus(); } },
			AccessibilityVerbositySettingId.Chat,
		);
		provider.onDidChangeContent = this.source.onDidChangeContent;
		return provider;
	}

	private messageText(item: IChatListItem): string {
		const sections = [this.labels.getAriaLabel(item)];
		if (item.timestamp !== undefined && item.type === 'agentMessage' && this.showAgentReplyTimestamps()) {
			sections.push(formatChatMessageTime(item.timestamp));
		}
		const invocation = item.toolInvocation;
		if (invocation) {
			const { call, output, result, stopped, waitingFor, executionStarted } = invocation;
			if (result) {
				sections.push(result.isError ? localize('chat.tool.failed', '{0} · Failed', call.name) : localize('chat.tool.completed', '{0} · Completed', call.name));
			} else if (!stopped && waitingFor) {
				switch (waitingFor) {
					case 'approval': sections.push(localize('chat.tool.awaitingApproval', '{0} · Awaiting approval', call.name)); break;
					case 'permissions': sections.push(localize('chat.tool.awaitingPermissions', '{0} · Awaiting permissions', call.name)); break;
					case 'userInput': sections.push(localize('chat.tool.awaitingUserInput', '{0} · Awaiting your response', call.name)); break;
					case 'dynamicTool': sections.push(localize('chat.tool.awaitingCapability', '{0} · Awaiting client tool', call.name)); break;
				}
			} else if (!stopped && (executionStarted || output.length > 0)) {
				sections.push(localize('chat.tool.running', '{0} · Running', call.name));
			} else {
				sections.push(stopped ? localize('chat.tool.stopped', '{0} · No result', call.name) : localize('chat.tool.pending', '{0} · Awaiting result', call.name));
			}
			// Preserve exact tool evidence as inert text; never interpret it as Markdown or load resources.
			if (call.binding) {
				for (const source of call.binding.sourceChain) {
					switch (source.type) {
						case 'product': sections.push(localize('chat.tool.product', 'Product: {0}', source.component)); break;
						case 'plugin': sections.push(localize('chat.tool.plugin', 'Plugin: {0} ({1})', source.pluginId, source.version)); break;
						case 'mcp': sections.push(localize('chat.tool.mcp', 'MCP: {0} / {1}', source.serverId, source.remoteName)); break;
						case 'dynamic': sections.push(localize('chat.tool.dynamic', 'Dynamic tool: {0}', source.name)); break;
						case 'extension': sections.push(localize('chat.tool.extension', 'Extension: {0}', source.id)); break;
						case 'system': sections.push(localize('chat.tool.system', 'System: {0}', source.id)); break;
					}
				}
				sections.push(getToolSpecificDataDescription(call.binding.activity));
				if (call.binding.caller.type === 'codeMode') { sections.push(localize('chat.tool.parent', 'Parent call: {0}', call.binding.caller.parentToolCallId)); }
			}
			sections.push(localize('chat.tool.input', 'Input') + '\n' + call.argumentsJson);
			for (const stream of ['stdout', 'stderr'] as const) {
				const text = output.filter(part => part.stream === stream).map(part => part.text).join('\n');
				if (text) { sections.push((stream === 'stdout' ? localize('chat.tool.stdout', 'Standard output') : localize('chat.tool.stderr', 'Standard error')) + '\n' + text); }
			}
			if (result) {
				sections.push(result.isError ? localize('chat.tool.error', 'Error') : localize('chat.tool.result', 'Result'));
				if (result.outputPreview) sections.push(localize('chat.tool.outputPreviewHelp', 'For a large tool result, open Result and choose Read full output. Use Next page and Previous page to read one page at a time. Back to preview returns to the excerpt.'));
				sections.push(result.text, ...this.attachments(result.content ?? []));
			}
		} else if (item.hookPart) {
			const { run } = item.hookPart;
			switch (run.status.type) {
				case 'running': sections.push(run.toolName ? localize('hooks.runningTool', 'Running {0} Hook for {1}', run.event, run.toolName) : localize('hooks.running', 'Running {0} Hook', run.event)); break;
				case 'continued': sections.push(run.toolName ? localize('hooks.feedbackTool', 'Allowed {0} · {1} Hook', run.toolName, run.event) : localize('hooks.feedback', 'Allowed by {0} Hook', run.event)); break;
				case 'denied': sections.push(run.toolName ? localize('hooks.blockedTool', 'Blocked {0} · {1} Hook', run.toolName, run.event) : localize('hooks.blocked', 'Blocked by {0} Hook', run.event), run.status.reason); break;
				case 'cancelled': sections.push(run.toolName ? localize('hooks.cancelledTool', '{0} Hook cancelled for {1}', run.event, run.toolName) : localize('hooks.cancelled', '{0} Hook cancelled', run.event), run.status.reason); break;
				case 'failed': sections.push(run.toolName ? localize('hooks.failedTool', '{0} Hook failed for {1}', run.event, run.toolName) : localize('hooks.failed', '{0} Hook failed', run.event), run.status.message); break;
			}
		} else {
			const markdown = item.type === 'agentMessage' || item.type === 'reasoning' || item.type === 'plan' || item.type === 'advisor';
			const rich = item.markdown?.richContent;
			sections.push(markdown ? rich ? renderChatRichContentText(item.text, rich) : renderChatMarkdownPlaintext(item.text) : item.text, item.contextText ?? '', item.detail ?? '');
			sections.push(...this.attachments(item.content ?? []));
			if (item.loadedSkills?.length) {
				sections.push(localize('chat.skills.loadedTitle', 'Skills loaded in this turn'));
				sections.push(...item.loadedSkills.map(skill =>
					localize('chat.skills.loadedDetail', '{0} · {1}', skill.name, formatLoadedSkillReason(skill.reason))));
			}
		}
		return sections.filter(Boolean).join('\n\n');
	}

	private attachments(content: readonly ChatContentPart[]): string[] {
		return content.map(part => {
			switch (part.type) {
				case 'text': return part.text;
				case 'imageUrl': return localize('chat.media.image', 'Image');
				case 'imageAttachment': return localize('chat.media.image', 'Image');
				case 'audioUrl': return localize('chat.media.audio', 'Audio');
				case 'audioAttachment': return localize('chat.media.audioDuration', 'Audio ({0} seconds)', Math.ceil(part.attachment.durationMs / 1000));
				case 'artifact': {
					const artifact = part.artifact;
					let body: string;
					if (artifact.data.type === 'bytes') {
						body = localize('chat.resource.binary', 'Binary resource ({0} bytes)', artifact.data.bytes.length);
					} else {
						body = artifact.data.type === 'text' ? artifact.data.text : artifact.data.json;
						const tree = !artifact.truncated && artifact.source.type !== 'resourceLink'
							&& artifact.source.type !== 'mcpApp' && artifact.source.type !== 'viewMetadata'
							&& artifact.data.type === 'json' ? reviveChatTreeData(artifact.data.json) : undefined;
						if (tree) {
							const lines = (entry: IChatResponseProgressFileTreeData, depth: number): string[] => [
								`${'  '.repeat(depth)}${entry.label} · ${entry.uri.toString()}`,
								...(entry.children ?? []).flatMap(child => lines(child, depth + 1)),
							];
							body = lines(tree.treeData, 0).join('\n');
						}
					}
					const metadata = artifact.truncated ? localize('chat.resource.truncated', '{0} · Truncated content', artifact.mimeType) : artifact.mimeType;
					return [metadata, 'uri' in artifact.source ? artifact.source.uri : '', body].filter(Boolean).join('\n');
				}
			}
		});
	}
}

export function getToolSpecificDataDescription(activity: ChatToolCallBinding['activity']): string {
	if (!activity) return '';
	switch (activity.type) {
		case 'confirmation': {
			const value = activity.presentation;
			switch (value.type) {
				case 'modifiedFiles': return value.files.map(file => [file.path, file.original, file.modified].filter(text => text !== undefined && text !== null).join('\n')).join('\n\n');
				case 'agentFeedbackReview': return value.message;
				case 'extensionsInstall': return [localize('chat.tool.installExtensions', 'Extensions requested for installation'), ...value.extensions].join('\n');
				case 'sandboxPrerequisite': return [localize('chat.tool.sandboxDependencies', 'Required sandbox dependencies'), ...value.dependencies, localize('chat.tool.sandboxRemediations', 'Proposed sandbox remediation'), ...value.remediations].join('\n');
				case 'authentication': return localize('chat.tool.signInProvider', 'Sign in to {0}', value.provider);
			}
		}
		case 'command': return localize('chat.tool.command', 'Command: {0}\nArguments: {1}\nDirectory: {2}', activity.program, JSON.stringify(activity.arguments), activity.workingDirectory);
		case 'fileRead': return localize('chat.tool.read', 'Read: {0}', activity.path);
		case 'fileSearch': return localize('chat.tool.search', 'Search: {0}\nDirectory: {1}', activity.pattern, activity.path);
		case 'fileList': return localize('chat.tool.list', 'List: {0}\nDirectory: {1}', activity.pattern, activity.path);
		case 'fileEdit': return localize('chat.tool.edit', 'Edit: {0}', activity.path);
		case 'read': return localize('chat.tool.read', 'Read: {0}', activity.target);
		case 'search': return localize('chat.tool.searchTarget', 'Search: {0}', activity.target);
		case 'list': return localize('chat.tool.listTarget', 'List: {0}', activity.target);
		case 'edit': return localize('chat.tool.edit', 'Edit: {0}', activity.target);
		case 'run': return localize('chat.tool.run', 'Run');
	}
}
