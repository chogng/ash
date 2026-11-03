import type { URI } from '../../../../../base/common/uri.js';
import type { ThemeIcon } from '../../../../../base/common/themables.js';
import type { IMarkdownString } from '../../../../../base/common/htmlContent.js';

export type ChatContextIconPath = ThemeIcon | URI | { light: URI; dark: URI; };

/** Provider content is resolved into a draft snapshot before the input accepts it. */
export interface StringChatContextValue {
	value?: string;
	name?: string;
	modelDescription?: string;
	iconPath?: ChatContextIconPath;
	uri: URI;
	resourceUri?: URI;
	tooltip?: IMarkdownString;
	readonly commandId?: string;
	readonly handle: number;
}

export interface IChatRequestWorkspaceVariableEntry {
	readonly id: string;
	readonly name: string;
	readonly kind: 'workspace';
	readonly value: string;
	readonly modelDescription?: string;
}
