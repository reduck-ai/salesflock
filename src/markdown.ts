// Evidence rendering — a generic, lossless YAML→Markdown pass for a projected field.
// A multi-line value that parses as structured YAML (the shape enrich stores) becomes
// nested bullets, every key and value emitted so nothing the source gave us is dropped;
// prose passes through untouched. Deterministic and renderer-agnostic: the judge's verbatim
// quotes anchor against exactly this rendering, frozen on the Decision, and any CommonMark
// renderer displays it — so value text stays verbatim and contiguous (never re-wrapped) and
// structure is carried by natural nesting. Null values are absence of data, not data — they
// carry nothing to render.

import { parse } from "yaml";

// One parsed value → markdown lines (relative indent; the caller nests by two spaces).
// An array item folds into a single bullet: its first line takes the dash, the rest
// stay indented inside it. Multi-line scalars keep their lines under a bare key.
const render = (v: unknown): string[] => {
	if (Array.isArray(v))
		return v.flatMap((item) => render(item).map((l, i) => (i === 0 ? `- ${l}` : `  ${l}`)));
	if (v !== null && typeof v === "object")
		return Object.entries(v)
			.filter(([, x]) => x != null)
			.flatMap(([k, x]) => {
				if (typeof x === "object") return [`**${k}:**`, ...render(x).map((l) => `  ${l}`)];
				const s = String(x);
				return s.includes("\n")
					? [`**${k}:**`, ...s.split("\n").map((l) => `  ${l}`)]
					: [`**${k}:** ${s}`];
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
