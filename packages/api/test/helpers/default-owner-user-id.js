// Single source of truth for the test-side owner identity. Routes compare the
// session user (header fixture) against thread/callback ownership (per-test
// harnesses), so both sides must resolve the same fallback when the env knob
// is unset — bare local gates run without CI's DEFAULT_OWNER_USER_ID and
// divergent literals turn them red (see review-notes 2026-09-17, PR #33 gate).
//
// Timing invariant: readHeaders/writeHeaders freeze this value at module
// load. Set DEFAULT_OWNER_USER_ID before importing the fixture, and never
// mutate it mid-file while using those headers — the harness side reads it
// live at call time. (Kept eager on purpose: lazy getters would ripple
// through every consumer's const usage for a currently-unreachable edge.)
export function resolveDefaultOwnerUserId() {
  return process.env.DEFAULT_OWNER_USER_ID?.trim() || 'owner-user';
}
