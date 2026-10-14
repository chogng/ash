/** References use the names registered by Ash's built-in browser tool owner. */
export const BrowserChatToolReferenceName = {
	OpenBrowserPage: 'browser_open',
	ReadPage: 'browser_observe',
	ScreenshotPage: 'browser_screenshot',
	NavigatePage: 'browser_navigate',
	ClickElement: 'browser_click',
	TypeInPage: 'browser_type',
} as const;

export const browserChatToolReferenceNames: readonly string[] = [
	...Object.values(BrowserChatToolReferenceName),
	'browser_scroll', 'browser_back', 'browser_reload', 'browser_close',
	'browser_list_pages', 'browser_hover', 'browser_drag', 'browser_handle_dialog', 'browser_run_playwright',
];
