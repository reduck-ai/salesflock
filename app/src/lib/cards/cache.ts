// The client-side card cache — the deck's "don't fetch twice". A viewed decision's judgment is
// held here so a revisit (←, a re-click) is instant, and `preloadData` warming a neighbour lands
// here too. Client-only by construction (the universal load guards on `browser`), so there is no
// cross-user server leak. Lifetime: the SPA session — it clears on a full page reload, and a card
// is evicted the moment it's written to (Save/Confirm), so a re-view reflects the new state.
//
// Insertion-ordered with a soft cap (a Map preserves order): past the cap, evict the oldest. A
// review session touches tens of cards, so the cap only guards a pathological run.

import type { EvidencedJudgment } from "./types";

const CAP = 80;
const cache = new Map<string, EvidencedJudgment>();

export const getCard = (id: string): EvidencedJudgment | undefined => cache.get(id);

export const setCard = (id: string, card: EvidencedJudgment): void => {
	cache.set(id, card);
	if (cache.size > CAP) cache.delete(cache.keys().next().value!);
};

// evict a card after any write to it, so its next view refetches the persisted draft / decision.
export const dropCard = (id: string): void => void cache.delete(id);
