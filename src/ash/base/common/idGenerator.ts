export class IdGenerator {
	private lastId = 0;

	constructor(private readonly prefix: string) {}

	nextId(): string {
		this.lastId += 1;
		return `${this.prefix}${this.lastId}`;
	}
}

export const defaultGenerator = new IdGenerator('id#');
