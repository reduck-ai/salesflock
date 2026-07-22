// The deck's ephemeral session state — the receipts scrollback (what you decided this visit) and
// the transient toast. Kept in module state so it survives the per-card navigations: each Confirm
// goto's to the next card's URL, remounting the page, and this outlives that. Cleared on return to
// the list. (A full reload resets it, exactly like the old in-memory deck.)

export interface Receipt {
	edited: boolean; // the human overturned the judge's output (committed differs) vs confirmed verbatim
	title: string;
	href?: string;
}

export const session = $state<{
	receipts: Receipt[];
	toast: { id: number; message: string } | null; // id monotonic → a re-fire remounts (restarts the bar)
}>({ receipts: [], toast: null });

let seq = 0;
export const pushReceipt = (r: Receipt) => session.receipts.push(r);
export const fireToast = (message: string) => (session.toast = { id: ++seq, message });
export const clearToast = () => (session.toast = null);
export const clearSession = () => {
	session.receipts = [];
	session.toast = null;
};
