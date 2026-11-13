import { findLast } from '../../base/common/arraysFind.js';
import { getExtensionForMimeType } from '../../base/common/mime.js';
import { basename } from '../../base/common/resources.js';
import { URI } from '../../base/common/uri.js';
import { localize } from '../../nls.js';
import { chatPlanListItem } from '../../workbench/contrib/chat/common/model/chatViewModel.js';
import type { Thread, ThreadTranscriptEntry, TurnChangeDetails } from '../../workbench/services/chat/common/chatService.js';
import { createSessionFileChange, type ISessionArtifact } from '../services/sessions/common/session.js';

export function getThreadSessionArtifacts(thread: Thread, entries: readonly ThreadTranscriptEntry[]): readonly ISessionArtifact[] {
	const artifacts: ISessionArtifact[] = [];
	const plans = new Map(thread.turns.flatMap(turn => {
		const item = findLast(turn.items, item => item.type === 'plan');
		const text = turn.plan ? chatPlanListItem(turn)?.text : item?.text;
		return text ? [[turn.turnId, text] as const] : [];
	}));
	for (const entry of entries) {
		if (entry.type === 'turnPlan') {
			const text = chatPlanListItem(entry)?.text;
			if (text) plans.set(entry.turnId, text);
			continue;
		}
		if (entry.type === 'item' && !entry.transient && entry.item.type === 'plan') {
			if (entry.item.text) plans.set(entry.turnId, entry.item.text);
			continue;
		}
		if (entry.type !== 'item' || entry.transient || entry.item.type !== 'toolResult' || entry.item.isError) continue;
		for (const [contentIndex, part] of (entry.item.content ?? []).entries()) {
			const coordinate = { sessionId: thread.sessionId, threadId: thread.threadId, itemId: entry.item.itemId, contentIndex };
			const id = JSON.stringify(['tool', coordinate]);
			const uri = URI.from({ scheme: 'ash-chat-artifact', query: id });
			if (part.type === 'imageAttachment') {
				const extension = part.attachment.mediaType.toLowerCase();
				artifacts.push({
					id, kind: 'image', label: localize({ bundle: 'ash.artifacts', key: 'sessions.artifacts.screenshot' }, 'Screenshot'),
					uri: uri.with({ path: `/screenshot.${extension}` }),
					source: { kind: 'attachment', coordinate, mimeType: `image/${extension}` },
				});
			} else if (part.type === 'imageUrl') {
				const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=]+)$/iu.exec(part.url);
				if (!match) continue;
				const mimeType = match[1]!.toLowerCase();
				artifacts.push({
					id, kind: 'image', label: localize({ bundle: 'ash.artifacts', key: 'sessions.artifacts.screenshot' }, 'Screenshot'),
					uri: uri.with({ path: `/screenshot${getExtensionForMimeType(mimeType) ?? '.png'}` }),
					source: { kind: 'dataImage', data: match[2]!, mimeType },
				});
			} else if (part.type === 'artifact') {
				const { artifact } = part;
				if (artifact.source.type !== 'embeddedResource' && artifact.source.type !== 'resourceLink') continue;
				if (artifact.source.type === 'embeddedResource' && artifact.truncated) continue;
				const mimeType = artifact.mimeType;
				const name = artifact.source.uri.split(/[/?#]/u).filter(Boolean).at(-1)?.replace(/[\\:*"<>|]/gu, '_') || 'resource';
				const extension = getExtensionForMimeType(mimeType);
				const label = extension && !/\.[a-z0-9]+$/iu.test(name) ? `${name}${extension}` : name;
				artifacts.push({
					id, kind: mimeType.startsWith('image/') ? 'image' : 'file', label,
					uri: uri.with({ path: `/${label}`, fragment: artifact.contentDigest }),
					source: artifact.source.type === 'resourceLink' ? { kind: 'toolResource', coordinate, mimeType }
						: artifact.data.type === 'bytes' ? { kind: 'bytes', bytes: artifact.data.bytes, mimeType }
							: { kind: 'text', text: artifact.data.type === 'text' ? artifact.data.text : artifact.data.json },
				});
			}
		}
	}
	for (const [turnId, text] of plans) {
		const id = JSON.stringify(['plan', thread.sessionId, thread.threadId, turnId]);
		artifacts.push({
			id, kind: 'plan', label: localize({ bundle: 'ash.artifacts', key: 'sessions.artifacts.plan' }, 'Plan'),
			uri: URI.from({ scheme: 'ash-chat-artifact', path: '/plan.md', query: id }),
			source: { kind: 'text', text },
		});
	}
	return artifacts;
}

/** Ordinary edits stay in Changes. A new file or a saved plan is also a conversation result. */
export function getCapturedSessionArtifacts(thread: Thread, captures: readonly TurnChangeDetails[]): readonly ISessionArtifact[] {
	const files = new Map<string, ISessionArtifact>();
	for (const { summary, files: changes } of captures) {
		if (summary.captureState !== 'sealed') continue;
		for (const file of changes) {
			if (file.path.split(/[\\/]/u).some(segment => !segment || segment === '.' || segment === '..') || file.path.includes(':')) continue;
			const key = JSON.stringify([summary.repositoryId, file.path]);
			const previousKey = file.previousPath && JSON.stringify([summary.repositoryId, file.previousPath]);
			const previous = files.get(previousKey || key);
			if (previousKey) files.delete(previousKey);
			// Captures expose text snapshots. A repository-relative binary path is not a readable resource.
			if (file.kind === 'deleted' || file.binary) {
				files.delete(key);
				continue;
			}
			const plan = /plan[^/]*\.md$/iu.test(file.path);
			if (!plan && file.kind !== 'added' && !previous) continue;
			const change = createSessionFileChange(summary, file);
			files.set(key, {
				id: previous?.id ?? JSON.stringify(['file', thread.sessionId, thread.threadId, key]), label: basename(change.modifiedUri),
				kind: plan ? 'plan' : 'file',
				uri: change.modifiedUri, source: { kind: 'capture', change },
			});
		}
	}
	return [...files.values()];
}
