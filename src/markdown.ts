// Evidence rendering — a generic, lossless YAML→Markdown pass for a projected field.
// A multi-line value that parses as structured YAML (the shape enrich stores) becomes
// headings, bold labels and flat bullets, every key and value emitted so nothing the
// source gave us is dropped; prose passes through untouched. Deterministic: the judge's
// verbatim quotes anchor against exactly this rendering, frozen on the Decision. Null
// values are absence of data, not data — they carry nothing to render.
//
// The one constraint that shapes it: the app renders this with snarkdown (~1 KB), which
// reads a line indented 3+ spaces as a code block and only supports a single, un-indented
// list level. So structure is carried by bold labels and `---` rules between an array's
// object items — NEVER by indentation or nested bullets — and value text stays verbatim
// and contiguous so every quote still resolves.

import { parse } from "yaml";

const isScalar = (v: unknown): boolean => v === null || typeof v !== "object";

// One parsed value → snarkdown-safe markdown lines. Object scalars become `- **key:** value`
// bullets; a multi-line scalar drops to its own un-indented paragraph under a bold label; a
// nested object/array is introduced by a bold label then rendered flat. An array of scalars
// is a bullet list; an array of objects is its items separated by `---` (blank-lined so the
// rule can't read as a setext heading).
const render = (v: unknown): string[] => {
	if (Array.isArray(v)) {
		const items = v.filter((x) => x != null);
		if (items.every(isScalar)) return items.map((x) => `- ${x}`);
		return items.flatMap((item, i) => (i ? ["", "---", ""] : []).concat(render(item)));
	}
	if (v !== null && typeof v === "object")
		return Object.entries(v)
			.filter(([, x]) => x != null)
			.flatMap(([k, x]) => {
				if (!isScalar(x)) return [`**${k}:**`, ...render(x)];
				const s = String(x);
				return s.includes("\n")
					? [`**${k}:**`, "", ...s.split("\n"), ""]
					: [`- **${k}:** ${s}`];
			});
	return [String(v)];
};

// markdown(field) — structured YAML → markdown; anything else (prose, or text that only
// *looks* like YAML on a single line, e.g. a "CEO: Building X" headline) stays as-is.
export const markdown = (field: string): string => {
	if (!field.includes("\n")) return field;
	let v: unknown;
	try {
		v = parse(field);
	} catch {
		return field;
	}
	return v !== null && typeof v === "object" ? render(v).join("\n") : field;
};
