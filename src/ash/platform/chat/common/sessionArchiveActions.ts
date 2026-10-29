import { Lxicon } from '../../../base/common/lxicons.js';
import type { ThemeIcon } from '../../../base/common/themables.js';
import { localize, localize2 } from '../../../nls.js';
import type { ICommandActionTitle } from '../../action/common/action.js';
import type { IConfigurationService } from '../../configuration/common/configuration.js';

export const ChatSessionArchiveActionWordingSettingId = 'chat.experimental.sessionArchiveActionWording';

export const enum ChatSessionArchiveActionWording {
	Archive = 'archive',
	MarkAsDone = 'done',
}

export interface IChatSessionArchiveAction {
	readonly title: ICommandActionTitle;
	readonly icon: ThemeIcon;
}

export interface IChatSessionArchiveActionPresentation {
	readonly archive: IChatSessionArchiveAction;
	readonly archiveAll: IChatSessionArchiveAction;
	readonly unarchive: IChatSessionArchiveAction;
	readonly unarchiveAll: IChatSessionArchiveAction;
}

export function getChatSessionArchiveActionWording(
	configurationService: IConfigurationService,
): ChatSessionArchiveActionWording {
	return configurationService.getValue(ChatSessionArchiveActionWordingSettingId) ===
		ChatSessionArchiveActionWording.MarkAsDone
		? ChatSessionArchiveActionWording.MarkAsDone
		: ChatSessionArchiveActionWording.Archive;
}

/** Presentation follows the UI preference; Session lifecycle remains backend-owned. */
export function getChatSessionArchiveActionPresentation(
	wording: ChatSessionArchiveActionWording,
): IChatSessionArchiveActionPresentation {
	const done = wording === ChatSessionArchiveActionWording.MarkAsDone;
	return {
		archive: {
			title: done
				? localize2('chatSession.markAsDone', 'Mark as Done')
				: localize2('chatSession.archive', 'Archive'),
			icon: done ? Lxicon.check : Lxicon.archive,
		},
		archiveAll: {
			title: done
				? localize2('chatSession.markAllAsDone', 'Mark All as Done')
				: localize2('chatSession.archiveAll', 'Archive All'),
			icon: done ? Lxicon.check : Lxicon.archive,
		},
		unarchive: {
			title: done ? localize2('chatSession.restore', 'Restore') : localize2('chatSession.unarchive', 'Unarchive'),
			icon: Lxicon.refresh,
		},
		unarchiveAll: {
			title: done
				? localize2('chatSession.restoreAll', 'Restore All')
				: localize2('chatSession.unarchiveAll', 'Unarchive All'),
			icon: Lxicon.refresh,
		},
	};
}

export function getChatSessionArchivedSectionLabel(wording: ChatSessionArchiveActionWording): string {
	return wording === ChatSessionArchiveActionWording.MarkAsDone
		? localize('chatSession.done', 'Done')
		: localize('chatSession.archived', 'Archived');
}
