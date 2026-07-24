// This agent's evidence renderer — the single declaration both consumers import (the runtime judge
// via tools.ts, the review app via $agent/evidence). The LinkedIn renderer is shared by two agents,
// so it lives in src/linkedin/; this re-export is how former-rpa-pms names it as its own. (x-engage,
// the sole consumer of its renderer, defines it in-file instead — same seam, different body.)
export { renderEvidence, fieldSpan } from "../../src/linkedin/evidence.js";
