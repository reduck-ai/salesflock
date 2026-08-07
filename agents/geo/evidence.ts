// geo has no evidence of its own to own, because it mints no Decision: every verdict here is a
// string comparison over evidence we fetched, computed at read time, so nothing is ever frozen for a
// human to rule on and nothing is ever rendered in the review app.
//
// The roster's `Agent` type asks every agent for these two functions all the same (agents/index.ts),
// so this re-exports the generic markdown-per-field renderer — the one src/linkedin/evidence.ts is
// already kept alive to be: the app's fallback for a Decision whose kind no agent declares. Saying
// "I have none" in one line beats widening the roster's contract for an agent that would never use it.
//
// The day this agent grows a Decision, this file is where its renderer goes.

export { renderEvidence, fieldSpan } from "../../src/linkedin/evidence.js";
