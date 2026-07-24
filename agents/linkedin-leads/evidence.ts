// This agent's evidence renderer — the single declaration both consumers import (the runtime judge
// via tools.ts, the review app via $agent/evidence). The LinkedIn renderer is shared by two agents,
// so it lives in src/linkedin/; this re-export is how linkedin-leads names it as its own.
export { renderEvidence, fieldSpan } from "../../src/linkedin/evidence.js";
