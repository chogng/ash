import { formatNlsMessage, getNLSLanguage } from '../../../../nls.js';

const chinese: Readonly<Record<string, string>> = {
	exampleTitle: "{0}范例",
	exampleDocsContent: "# 工作室发布简报\n\n为工作室的创作成果建立一个共享空间。先邀请少量成员试用，再根据反馈准备公开发布。\n\n## 准备清单\n\n- [x] 审阅视觉方向\n- [ ] 邀请试用成员\n- [ ] 发布更新说明\n\n## 日程\n\n| 里程碑 | 目标日期 |\n| --- | --- |\n| 试用 | 周二 |\n| 讨论反馈 | 周四 |\n| 公开发布 | 下周一 |",
	exampleItem: "项目",
	exampleOwner: "负责人",
	exampleBudget: "预算",
	exampleSpent: "已支出",
	exampleVisuals: "视觉设计",
	exampleCopy: "文案",
	examplePilot: "试用",
	exampleDay: "日期",
	exampleVisits: "访问量",
	exampleSignups: "注册量",
	exampleLaunch: "工作室发布",
	exampleSlidesTagline: "共享工作室的创作成果",
	exampleSchedule: "发布日程",
	exampleFeedback: "讨论反馈",
	exampleRelease: "发布更新说明",
	exampleLandingPage: "落地页",
	exampleDesignHeadline: "为好作品\n留出空间",
	exampleDesignBody: "在这里分享想法，把它们变成作品。",
	exampleExplore: "探索工作室",
	exampleInvite: "邀请五位同事",
	exampleDiscuss: "讨论试用记录",
	exampleShare: "分享发布清单",
	exampleAnimatedCircle: "动画圆形",
};

export function exampleText(key: string, fallback: string, title?: string): string {
	const message = getNLSLanguage() === 'zh-CN' ? chinese[key] ?? fallback : fallback;
	return formatNlsMessage(message, title === undefined ? undefined : { '0': title });
}
