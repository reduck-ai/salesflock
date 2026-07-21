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

const isCurrent = (p: Position): boolean => /present/i.test(p.dateRange ?? "");

// A senior product-MANAGEMENT title: a seniority marker + "product", but NOT the adjacent functions
// that share the word — product marketing / operations / design. This session caught the confusion
// (broustas = Product Marketing, arunlak = Product Operations were false "senior PM"s).
const isSeniorPM = (title: string | null): boolean =>
	!!title &&
	/\b(senior|sr\.?|principal|group|lead|director|head|vp|vice president)\b/i.test(title) &&
	/\bproduct\b/i.test(title) &&
	!/marketing|operations|design/i.test(title);

export type PreQualVerdict = "former-senior-pm" | "still-at-vendor" | "former-non-pm" | "never";

export interface PreQual {
	verdict: PreQualVerdict;
	pass: boolean; // the gate: former (left) AND was a senior PM at a vendor
	vendors: string[];
	vendorRoles: { title: string | null; dateRange: string | null; vendor: string }[];
}

// classify(experience) — the gate. `pass` ⇔ has ≥1 vendor position, none current (they left), and
// at least one vendor role is a senior PM. Otherwise the reason why: still-at-vendor / former-non-pm
// / never (the tool/skill-mention false positives this session's checks exposed).
export const classify = (experience: Experience): PreQual => {
	const vps = experience.positions
		.map((p) => ({ p, vendor: vendorOf(p) }))
		.filter((x): x is { p: Position; vendor: string } => !!x.vendor);
	const vendors = [...new Set(vps.map((x) => x.vendor))];
	const vendorRoles = vps.map((x) => ({ title: x.p.title, dateRange: x.p.dateRange, vendor: x.vendor }));
	const atVendorNow = vps.some((x) => isCurrent(x.p));
	const seniorPM = vps.some((x) => isSeniorPM(x.p.title));
	const verdict: PreQualVerdict = !vps.length
		? "never"
		: atVendorNow
			? "still-at-vendor"
			: seniorPM
				? "former-senior-pm"
				: "former-non-pm";
	return { verdict, pass: verdict === "former-senior-pm", vendors, vendorRoles };
};
