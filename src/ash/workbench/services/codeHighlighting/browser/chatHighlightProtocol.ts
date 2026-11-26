export const chatHighlightChannel = { protocol: 'ash.chat.highlight', version: 1 } as const;
export const maximumChatHighlightLength = 256 * 1024;
export const chatHighlightTokenTypes = new Set([
	'attribute', 'comment', 'constant', 'function', 'keyword', 'number',
	'operator', 'property', 'punctuation', 'string', 'type', 'variable',
]);
