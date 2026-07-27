import { mode } from "$lib/server/auth";
import { decisions } from "$lib/server/notion";
import { decisionToRow } from "$lib/cards/decision";
import { parseFilter } from "$lib/filter";
import { KINDS } from "$agents/index";
import type { LayoutServerLoad } from "./$types";

// the per-Prompt dropdown's options — every agent's declared prompt Names (the queue is mixed), so
// they're stable whatever the current filter (deriving them from the fetched rows would drop
// options once a prompt is picked).
const promptNames = KINDS;

// The per-FILTER rail — the ordered working set the list renders and the deck navigates. This load
// reads ONLY `url.searchParams` (via parseFilter) and never `params.id`, so SvelteKit does NOT
// re-run it when only the card id changes: the rail is computed once per filter and reused across
// every card step under it. `depends("app:rail")` lets a Confirm invalidate it so the decided row
// leaves the set. One `decisions(filter)` call serves both the list rows and the deck rail.
export const load: LayoutServerLoad = async ({ locals, url, depends }) => {
	depends("app:rail");
	const user = locals.user;
	const filter = parseFilter(url.searchParams);
	if (!user) return { user, mode, filter, prompts: promptNames, rows: [] };
	const set = await decisions(filter);
	return { user, mode, filter, prompts: promptNames, rows: set.map(decisionToRow) };
};
