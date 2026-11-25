/** Comparison identity for session links; callers retain the original link for opening. */
export function linkKey(link: string): string {
	let end = link.length;
	while (end > 0 && link[end - 1] === '/') {
		end--;
	}
	return link.slice(0, end).toLowerCase();
}
