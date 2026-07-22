// The one description of the review working set — carried on the URL query string, so the list and
// the deck share it verbatim: the list builds it, a row link hands it to the deck, prev/next and
// Confirm preserve it. `tab` alone is the server-side Notion cut (pending vs decided); prompt /
// feedback / sort are applied in code over the fetched set (decisions()), so this stays a plain
// value object with no store coupling. parseFilter fills every field, so a bare `/` is a valid set.

export type Tab = "review" | "past";
export type Feedback = "any" | "has" | "none";
export type Sort = "date" | "prompt";

export interface Filter {
	tab: Tab;
	prompt: string; // "all" | a Prompt Name (the row's resolved kind); matched by equality
	feedback: Feedback;
	sort: Sort;
}

export const DEFAULT: Filter = { tab: "review", prompt: "all", feedback: "any", sort: "date" };

const oneOf = <T extends string>(v: string | null, allowed: readonly T[], fallback: T): T =>
	allowed.includes(v as T) ? (v as T) : fallback;

// searchParams → a fully-populated Filter (every field defaulted). `prompt` is free text (a Name),
// so it passes through as-is, empty → "all".
export const parseFilter = (params: URLSearchParams): Filter => ({
	tab: oneOf(params.get("tab"), ["review", "past"], DEFAULT.tab),
	prompt: params.get("prompt") || DEFAULT.prompt,
	feedback: oneOf(params.get("feedback"), ["any", "has", "none"], DEFAULT.feedback),
	sort: oneOf(params.get("sort"), ["date", "prompt"], DEFAULT.sort)
});

// Filter → a canonical query string (leading "?"), omitting fields left at their default so a
// pristine set gives the shortest URL. Stable field order → a stable, diff-friendly link.
export const filterQuery = (f: Filter): string => {
	const q = new URLSearchParams();
	if (f.tab !== DEFAULT.tab) q.set("tab", f.tab);
	if (f.prompt !== DEFAULT.prompt) q.set("prompt", f.prompt);
	if (f.feedback !== DEFAULT.feedback) q.set("feedback", f.feedback);
	if (f.sort !== DEFAULT.sort) q.set("sort", f.sort);
	const s = q.toString();
	return s ? `?${s}` : "";
};
