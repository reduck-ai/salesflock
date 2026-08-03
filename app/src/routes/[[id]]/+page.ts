// The per-card load — universal, so it can consult the client cache and skip the network on a
// revisit (the server load can't: SvelteKit re-runs it on every navigation). No id → the list,
// which renders from the layout's rows. With an id: on the client, a cache hit returns instantly;
// a miss fetches the one card from /api/decision and caches it (so `preloadData` warms the cache
// too). On the server (SSR / deep link) we always fetch — the cache is client-only, no cross-user
// state. Evicted on write in +page.svelte, so a re-view reflects the persisted draft/decision.

import { browser } from "$app/environment";
import { getCard, setCard } from "$lib/cards/cache";
import type { EvidencedJudgment } from "$lib/cards/types";
import type { PageLoad } from "./$types";

const norm = (id: string) => id.replace(/-/g, "");

export const load: PageLoad = async ({ params, fetch }) => {
	if (!params.id) return {};
	const id = norm(params.id);
	if (browser) {
		const hit = getCard(id);
		if (hit) return { current: hit };
	}
	const res = await fetch(`/api/decision/${id}`);
	// Name WHICH layer refused. This fetch is to our OWN api route, so a 401 is this app's Google gate
	// and never Notion — but a bare status reads exactly like a store failure, which sends you off
	// verifying a token that was fine all along (measured: `/users/me` 200 and every data source
	// readable, while the page still 401'd because the caller simply had no session).
	if (!res.ok)
		throw new Error(
			`decision ${id}: ${res.status}${res.status === 401 ? " — not signed in (this app's gate, not Notion)" : ""}`
		);
	const current = (await res.json()) as EvidencedJudgment;
	if (browser) setCard(id, current);
	return { current };
};
