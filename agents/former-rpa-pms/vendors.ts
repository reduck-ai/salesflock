// The deterministic pre-qualification — the objective ICP facts an LLM should never judge: was this
// person a SENIOR product manager at an RPA vendor, and have they LEFT? Both are facts in the
// experience data — a position whose companyUrl carries a vendor company-id, a senior product-
// MANAGEMENT title, and a dateRange that has ended. Pure: a function of positions, no I/O. This is
// the funnel's cheap gate; only survivors reach the costly LLM `qualify`.

import type { Experience } from "../../src/clients/lk/schema.js";

// The RPA vendors by their stable LinkedIn company-id — the /company/<id>/ in a position's companyUrl.
export const VENDORS: Record<string, string> = {
	"1523656": "UiPath",
	"208639": "Automation Anywhere",
	"138522": "SS&C Blue Prism"
};

type Position = Experience["positions"][number];

const vendorOf = (p: Position): string | undefined =>
	VENDORS[p.companyUrl?.match(/\/company\/(\d+)/)?.[1] ?? ""];

// Recognize a vendor by NAME (not the stable company-id). Used ONLY to detect ambiguity — a
// position that names a vendor but lost its companyUrl can't be confirmed by id — so it can defer
// an elimination, never grant a pass (that stays strictly id-gated).
const VENDOR_PATTERNS = [/uipath/i, /automation anywhere/i, /blue prism/i];
const namesVendor = (company: string | null): boolean =>
	!!company && VENDOR_PATTERNS.some((re) => re.test(company));

const isCurrent = (p: Position): boolean => /present/i.test(p.dateRange ?? "");

// A senior product-MANAGEMENT title: a seniority marker + "product", but NOT the adjacent functions
// that share the word — product marketing / operations / design. This session caught the confusion
// (broustas = Product Marketing, arunlak = Product Operations were false "senior PM"s).
const isSeniorPM = (title: string | null): boolean =>
	!!title &&
	/\b(senior|sr\.?|principal|group|lead|director|head|vp|vice president)\b/i.test(title) &&
	/\bproduct\b/i.test(title) &&
	!/marketing|operations|design/i.test(title);

export type PreQualVerdict =
	| "former-senior-pm"
	| "still-at-vendor"
	| "former-non-pm"
	| "never"
	| "insufficient-data";

export interface PreQual {
	verdict: PreQualVerdict;
	pass: boolean; // advance to enrich: former (left) AND was a senior PM at a vendor
	eliminate: boolean; // terminal "Not qualified": a data-backed miss. NEVER set on insufficient-data.
	vendors: string[];
	vendorRoles: { title: string | null; dateRange: string | null; vendor: string }[];
}

// disposition(pq) — the one-line, human-readable reason a pre-qualify verdict reached its Status,
// for the Lead's comment trail. The negative branches say why it was rejected; the pass branch why
// it advanced. A pure function of the verdict already computed — no re-derivation.
export const disposition = (pq: PreQual): string => {
	const at = pq.vendors.join(", ") || "an RPA vendor";
	switch (pq.verdict) {
		case "never":
			return "Not qualified — no RPA-vendor position in their experience";
		case "still-at-vendor":
			return `Not qualified — still at ${at} (current), not a former PM`;
		case "former-non-pm":
			return `Not qualified — former ${at}, but never a senior product manager there`;
		case "former-senior-pm":
			return `Pre-qualified — former ${at} senior product manager`;
		case "insufficient-data":
			return "Deferred — not enough experience data to eliminate; retry pre-qualify";
	}
};

// classify(experience) — the gate. `pass` ⇔ has ≥1 vendor position, none current (they left), and
// at least one vendor role is a senior PM. Otherwise the reason why: still-at-vendor / former-non-pm
// / never (the tool/skill-mention false positives this session's checks exposed).
export const classify = (experience: Experience): PreQual => {
	const positions = experience.positions;
	const vps = positions
		.map((p) => ({ p, vendor: vendorOf(p) }))
		.filter((x): x is { p: Position; vendor: string } => !!x.vendor);
	const vendors = [...new Set(vps.map((x) => x.vendor))];
	const vendorRoles = vps.map((x) => ({ title: x.p.title, dateRange: x.p.dateRange, vendor: x.vendor }));
	const atVendorNow = vps.some((x) => isCurrent(x.p));
	const seniorPM = vps.some((x) => isSeniorPM(x.p.title));

	// We eliminate ONLY on sufficient data — never drop a lead for want of it. Two gaps make an
	// elimination unsafe, so both defer to "insufficient-data" (the lead stays "To pre-qualify" for a
	// retry, never "Not qualified"): (1) no positions at all — the scrape gave us nothing to judge on;
	// (2) no vendor matched by company-id, yet a position NAMES a vendor but lost its companyUrl — our
	// stable key can't confirm it, so a "never" verdict isn't trustworthy while that ambiguity stands.
	const insufficient =
		!positions.length ||
		(!vps.length && positions.some((p) => !p.companyUrl && namesVendor(p.company)));

	const verdict: PreQualVerdict = insufficient
		? "insufficient-data"
		: !vps.length
			? "never"
			: atVendorNow
				? "still-at-vendor"
				: seniorPM
					? "former-senior-pm"
					: "former-non-pm";
	return {
		verdict,
		pass: verdict === "former-senior-pm",
		eliminate: verdict === "never" || verdict === "still-at-vendor" || verdict === "former-non-pm",
		vendors,
		vendorRoles
	};
};
