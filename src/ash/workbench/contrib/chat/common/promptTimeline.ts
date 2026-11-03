export const PROMPT_TIMELINE_STICKY_SCROLL_SETTING = 'chat.stickyScroll.enabled';
export const PROMPT_TIMELINE_DISPLAY_SETTING = 'sessions.chatTimeline.display';
export const PROMPT_TIMELINE_RAIL_STYLES = ['off', 'ruler', 'gutter'] as const;
export type PromptTimelineRailStyle = typeof PROMPT_TIMELINE_RAIL_STYLES[number];
