/** A process snapshot. Memory is resident bytes and load is CPU percent. */
export interface ProcessItem {
	name: string;
	cmd: string;
	pid: number;
	ppid: number;
	load: number;
	mem: number;
	children?: ProcessItem[];
}
