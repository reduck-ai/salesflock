// A time WINDOW, as an operator types one. The whole module, because that is the whole idea: every
// agent that selects "since" needs to turn "48h" into an instant, and none of them should own the
// parser. It lived in the reddit client, which made it that source's property by accident — geo's
// `search --again 7d` needed exactly the same thing and had a choice between importing another
// agent's client and copying ten lines. Neither is right, so it moved here.

export const sinceIso = (window: string): string => {
	const m = window.match(/^(\d+)\s*([hd])$/i);
	if (m) return new Date(Date.now() - Number(m[1]) * (m[2].toLowerCase() === "h" ? 3_600_000 : 86_400_000)).toISOString();
	const t = Date.parse(window);
	if (Number.isNaN(t)) throw new Error(`not a window: "${window}" — use "48h", "7d", or an ISO date`);
	return new Date(t).toISOString();
};
