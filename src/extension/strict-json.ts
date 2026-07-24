class StrictJsonScanner {
	private index = 0;
	private depth = 0;
	private readonly text: string;
	private readonly label: string;

	constructor(text: string, label: string) {
		this.text = text;
		this.label = label;
	}

	scan(): void {
		this.skipWhitespace();
		this.scanValue();
		this.skipWhitespace();
		if (this.index !== this.text.length) this.fail("has trailing content");
	}

	private fail(reason: string): never {
		throw new Error(`${this.label} ${reason}`);
	}

	private skipWhitespace(): void {
		while (
			this.index < this.text.length &&
			(this.text[this.index] === " " ||
				this.text[this.index] === "\t" ||
				this.text[this.index] === "\n" ||
				this.text[this.index] === "\r")
		)
			this.index += 1;
	}

	private scanValue(): void {
		const character = this.text[this.index];
		if (character === "{") this.scanNested(() => this.scanObject());
		else if (character === "[") this.scanNested(() => this.scanArray());
		else if (character === '"') this.scanStringToken();
		else if (character === "t") this.scanLiteral("true");
		else if (character === "f") this.scanLiteral("false");
		else if (character === "n") this.scanLiteral("null");
		else if (
			character === "-" ||
			(character !== undefined && /[0-9]/u.test(character))
		)
			this.scanNumber();
		else this.fail("is not valid JSON");
	}

	private scanNested(scan: () => void): void {
		this.depth += 1;
		if (this.depth > 128) this.fail("nesting depth exceeds 128");
		try {
			scan();
		} finally {
			this.depth -= 1;
		}
	}

	private scanObject(): void {
		this.index += 1;
		this.skipWhitespace();
		if (this.text[this.index] === "}") {
			this.index += 1;
			return;
		}
		const names = new Set<string>();
		while (true) {
			if (this.text[this.index] !== '"')
				this.fail("has a non-string object key");
			const token = this.scanStringToken();
			let name: string;
			try {
				name = JSON.parse(token) as string;
			} catch {
				this.fail("contains an invalid object key");
			}
			if (names.has(name))
				this.fail(`contains duplicate object key ${JSON.stringify(name)}`);
			names.add(name);
			this.skipWhitespace();
			if (this.text[this.index] !== ":")
				this.fail("is missing an object colon");
			this.index += 1;
			this.skipWhitespace();
			this.scanValue();
			this.skipWhitespace();
			const delimiter = this.text[this.index];
			if (delimiter === "}") {
				this.index += 1;
				return;
			}
			if (delimiter !== ",") this.fail("has an invalid object delimiter");
			this.index += 1;
			this.skipWhitespace();
		}
	}

	private scanArray(): void {
		this.index += 1;
		this.skipWhitespace();
		if (this.text[this.index] === "]") {
			this.index += 1;
			return;
		}
		while (true) {
			this.scanValue();
			this.skipWhitespace();
			const delimiter = this.text[this.index];
			if (delimiter === "]") {
				this.index += 1;
				return;
			}
			if (delimiter !== ",") this.fail("has an invalid array delimiter");
			this.index += 1;
			this.skipWhitespace();
		}
	}

	private scanStringToken(): string {
		const start = this.index;
		this.index += 1;
		while (this.index < this.text.length) {
			const character = this.text[this.index];
			if (character === '"') {
				this.index += 1;
				return this.text.slice(start, this.index);
			}
			if (character === "\\") {
				this.index += 1;
				const escaped = this.text[this.index];
				if (escaped === "u") {
					const digits = this.text.slice(this.index + 1, this.index + 5);
					if (!/^[0-9a-fA-F]{4}$/u.test(digits))
						this.fail("contains an invalid Unicode escape");
					this.index += 5;
					continue;
				}
				if (escaped === undefined || !'"\\/bfnrt'.includes(escaped))
					this.fail("contains an invalid string escape");
				this.index += 1;
				continue;
			}
			if (character === undefined || character.charCodeAt(0) <= 0x1f)
				this.fail("contains an unescaped control character");
			this.index += 1;
		}
		this.fail("contains an unterminated string");
	}

	private scanLiteral(literal: string): void {
		if (this.text.slice(this.index, this.index + literal.length) !== literal)
			this.fail("contains an invalid literal");
		this.index += literal.length;
	}

	private scanNumber(): void {
		const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
			this.text.slice(this.index),
		);
		if (!match) this.fail("contains an invalid number");
		this.index += match[0].length;
	}
}

export function decodeStrictUtf8Json(
	bytes: Uint8Array,
	label: string,
): unknown {
	if (
		bytes.byteLength >= 3 &&
		bytes[0] === 0xef &&
		bytes[1] === 0xbb &&
		bytes[2] === 0xbf
	)
		throw new Error(`${label} UTF-8 BOM is not allowed`);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error(`${label} must be strict UTF-8`);
	}
	return parseStrictJson(text, label);
}

export function parseStrictJson(text: string, label: string): unknown {
	if (text.charCodeAt(0) === 0xfeff)
		throw new Error(`${label} BOM is not allowed`);
	new StrictJsonScanner(text, label).scan();
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`${label} is not valid JSON`);
	}
}
