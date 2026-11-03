// Only direct requests with an identifiable action or deliverable enter execution.
// Questions about an operation and quoted examples stay with the reply backend.
export function shouldRunCowork(text: string): boolean {
	const request = text.trim().replace(/^(?:(?:please|could you|can you|would you)\s+)+/iu, '');
	if (/^(?:how|what|why|when|where|which|who|explain|describe|tell me|show me how)\b/iu.test(request)
		|| /^(?:(?:请|帮我|麻烦你)\s*)*(?:怎么|如何|为什么|什么是|解释|告诉我)/u.test(request)) return false;
	if (/^(?:open|read|inspect|organize|sort|rename|move|copy|download|upload|edit|update|convert|merge|compare|analyze|summari[sz]e|research|find|look up|check|search)\b/iu.test(request)) {
		return /\b(?:files?|folders?|directories|documents?|attachments?|spreadsheets?|slides?|decks?|pdfs?|reports?|web(?:sites?| pages?)?|sources?|inbox|calendar|data(?:sets?)?|interviews?)\b|https?:\/\//iu.test(request);
	}
	if (/^(?:create|make|build|generate|write|draft|prepare|produce|export|save|turn|put)\b/iu.test(request)) {
		return /\b(?:files?|documents?|spreadsheets?|slides?|decks?|pdfs?|reports?|presentations?|workbooks?|charts?|powerpoint|excel|docx|xlsx|pptx|csv)\b/iu.test(request);
	}
	const chinese = request.replace(/^(?:(?:请|帮我|替我|给我|麻烦你)\s*)+/u, '');
	const action = /^(?:打开|读取|检查|整理|重命名|移动|复制|下载|上传|编辑|更新|转换|合并|比较|分析|汇总|调研|研究|搜索|查找|查一下|处理|生成|创建|制作|做|写|起草|准备|导出|保存|把|将)/u.test(chinese)
		|| /^(?:用|根据|基于).{1,100}(?:生成|制作|整理|导出|写一|做一|做个)/u.test(chinese);
	return action
		&& /文件|目录|文件夹|文档|附件|数据|表格|演示|幻灯片|报告|访谈|网页|网站|日历|邮件|资料|图表|PDF|PPT|CSV|Excel|https?:\/\//iu.test(chinese);
}
