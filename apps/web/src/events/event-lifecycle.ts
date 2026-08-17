/**
 * Client mirror of the seller event lifecycle's legality table.
 *
 * AUTHORITY IS SERVER-SIDE. `apps/api/src/events/event.service.ts`
 * (`resolveLifecycleTransition`) decides every transition and authors every
 * refusal message (D-002). This module exists for one narrower job: letting the
 * Event Manager DISABLE a control the server would refuse, instead of offering
 * a button whose only possible outcome is a 409. It decides nothing the server
 * does not, and a control that slips through still meets the real gate.
 *
 * `event-lifecycle.test.ts` is DIFFERENTIAL, not a restatement: it imports the
 * real resolver and asserts this mirror agrees with it across the entire finite
 * status x action cross-product, refusal strings included. A hand-written
 * expectation table here would agree with the server exactly when both were
 * wrong in the same way — which is the drift a mirror is supposed to catch.
 */

export type EventLifecycleAction = 'schedule' | 'go-live' | 'end';
export type EventLifecycleStatus = 'draft' | 'scheduled' | 'live' | 'ended';

/**
 * A start time known to parse, for asking whether an action is refused by the
 * event's STATE ALONE. Without it, "Schedule" on a draft with an empty date
 * field is indistinguishable from "Schedule" on a live event — the first is a
 * form the seller has not filled in yet, the second is a rule they need told
 * about, and only the second belongs in a standing hint under the controls.
 */
const PARSEABLE_PROBE_INSTANT = '1970-01-01T00:00:00.000Z';

/** Mirror of the server's `normalizedInstant` accept/reject decision. */
function parseableInstant(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return !Number.isNaN(Date.parse(value.trim()));
}

/**
 * The refusal the server WOULD return for this move, or `null` when it would
 * be accepted. Reason strings are the server's own, verbatim; the differential
 * test fails if either side edits one without the other.
 */
export function lifecycleRefusal(
  status: EventLifecycleStatus,
  action: EventLifecycleAction,
  startsAt?: string | null,
): string | null {
  if (action === 'schedule') {
    if (status === 'live') return 'End the live event before rescheduling it.';
    if (!parseableInstant(startsAt)) {
      return 'A valid ISO-8601 start time is required to schedule an event.';
    }
    return null;
  }

  // Go-live is legal from every state, and idempotent from `live`.
  if (action === 'go-live') return null;

  if (status === 'ended') return null;
  if (status !== 'live') {
    return 'Only a live event can be ended. Unpublish it instead to withdraw it before it airs.';
  }
  return null;
}

/**
 * The refusal that depends on the event's state alone, ignoring form input —
 * the half of a refusal worth explaining unprompted.
 */
export function lifecycleStatusRefusal(
  status: EventLifecycleStatus,
  action: EventLifecycleAction,
): string | null {
  return lifecycleRefusal(status, action, PARSEABLE_PROBE_INSTANT);
}

/**
 * A `datetime-local` value as an instant the API will accept, or `null` when
 * the field is empty or half-typed.
 *
 * The input hands back LOCAL wall time with no zone (`2026-08-17T09:30`), which
 * `new Date()` reads as local per the ES date-time-form rule; the API stores
 * UTC. Skipping this conversion is a silent timezone-sized error rather than a
 * visible failure, so the seller's stated 9:30 must become 9:30 THEIR time.
 */
export function instantFromLocalInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
