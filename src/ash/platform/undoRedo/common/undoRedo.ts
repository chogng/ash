export class UndoRedoGroup {
	private static idPool = 0;

	public static None = new UndoRedoGroup();

	public readonly id: number;
	private order = 1;

	constructor() {
		this.id = UndoRedoGroup.idPool++;
	}

	public nextOrder(): number {
		if (this.id === 0) {
			return 0;
		}
		return this.order++;
	}
}
