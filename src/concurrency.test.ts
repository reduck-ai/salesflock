// The pacer's two invariants — the clock a rate-limited backend needs. Timing is asserted with
// generous floors (never exact sleeps): the claim is "no sooner than", which is what a rate limit
// says, so a slow machine can only make these pass more easily.
// Run: npm run build && node --test dist/src/concurrency.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { pace } from "./concurrency.js";

test("pace: starts are spaced by 1/rps, however wide the fan-out", async () => {
	const slot = pace(100); // 10ms apart
	const t0 = Date.now();
	const starts: number[] = [];
	await Promise.all(
		Array.from({ length: 5 }, () => slot(async () => void starts.push(Date.now() - t0)))
	);
	assert.equal(starts.length, 5);
	// 5 requests at 10ms apart cannot all have started inside the first interval.
	assert.ok(starts[4] >= 35, `last start at ${starts[4]}ms, expected ≥35ms`);
	starts.slice(1).forEach((s, i) => assert.ok(s >= starts[i], "starts are ordered"));
});

test("pace: hold parks every caller — in flight and future — not just the one that hit the limit", async () => {
	const slot = pace(1000);
	const t0 = Date.now();
	// One call learns the backend is out (as the store's 429 branch does) and holds the clock.
	await slot(async () => slot.hold(120));
	// A caller already waiting on the pace, and one arriving after: both start after the hold.
	const [a, b] = await Promise.all([
		slot(async () => Date.now() - t0),
		slot(async () => Date.now() - t0)
	]);
	assert.ok(a >= 120, `parked caller started at ${a}ms, expected ≥120ms`);
	assert.ok(b >= 120, `later caller started at ${b}ms, expected ≥120ms`);
});
