// The X evidence renderer — the seam decide.ts (and, later, the review app) uses to turn a
// Decision's frozen Input map into the Markdown the judge reads and a quote anchors against. X
// evidence is plain text (the post body, the author's answered-replier exchanges), so unlike
// LinkedIn's Activity there is no special per-field renderer — each field is a `### key` section
// of generic Markdown. A Decision freezes the Input map, so improving this reflows every X
// Decision on read. Its own sibling under src/x/, mirroring src/linkedin/evidence.ts.

import { markdown } from "../markdown.js";

export const renderEvidence = (input: Record<string, string>): string =>
	Object.entries(input)
		.map(([k, v]) => `### ${k}\n\n${markdown(v)}`)
		.join("\n\n");
