/** Synthetic source shared by browser and real Desktop acceptance. */
export function createLargeMarkdownDocument(): string {
	const header = '\uFEFF---\r\ntitle: 大文件中文😀\r\n---\r\n\r\n# 大文件 Markdown\r\n\r\n中文段落 **原有加粗** 和 [引用][id]  \r\n保留换行与 \\*转义\\*。\r\n\r\n';
	const paragraphs = Array.from({ length: 9000 }, (_, index) => `段落 ${index}：中文😀 **加粗**、[引用][id]、\\*原始转义\\* &amp;  \r\n下一行保留两个尾随空格。  \r\n\r\n`).join('');
	let state = 0x12345678;
	const rows = Array.from({ length: 8000 }, () => {
		let row = '';
		for (let index = 0; index < 64; index++) {
			state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
			row += (state >>> 0).toString(16).padStart(8, '0');
		}
		return row;
	}).join('\r\n');
	return header + paragraphs + '> '.repeat(40) + '深层嵌套仍保真。\r\n\r\n```text\r\n' + rows + '\r\n```\r\n\r\n[id]: <https://example.com>  "原有标题"\r\n';
}
