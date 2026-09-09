const TURN_MAX_AGE_MS = 30 * 60 * 1000;

interface RetargetTurn {
  sourceMessageId: string;
  userId: string | null;
  recordedAt: number;
}

type TurnAuthorization =
  | { allowed: true; sourceMessageId: string; userId: string }
  | { allowed: false; reason: string };

const currentTurns = new Map<string, RetargetTurn>();

/** Record the newest engaged inbound message for a session. Host process only. */
export function recordTaskRetargetTurn(sessionId: string, sourceMessageId: string, userId: string | null): void {
  currentTurns.set(sessionId, { sourceMessageId, userId, recordedAt: Date.now() });
}

/** Resolve the current user turn without trusting any identity supplied by the agent. */
export function authorizeTaskRetargetTurn(sessionId: string): TurnAuthorization {
  const turn = currentTurns.get(sessionId);
  if (!turn) return { allowed: false, reason: 'task retarget requires a current authorized Slack message' };

  const age = Date.now() - turn.recordedAt;
  if (!Number.isFinite(age) || age > TURN_MAX_AGE_MS) {
    currentTurns.delete(sessionId);
    return { allowed: false, reason: 'task retarget authorization expired; ask again in a new Slack message' };
  }
  if (!turn.userId) return { allowed: false, reason: 'the current Slack sender could not be verified' };

  return { allowed: true, sourceMessageId: turn.sourceMessageId, userId: turn.userId };
}

/** Consume the exact turn only after a successful retarget. */
export function consumeTaskRetargetTurn(sessionId: string, sourceMessageId: string): void {
  const turn = currentTurns.get(sessionId);
  if (turn?.sourceMessageId === sourceMessageId) currentTurns.delete(sessionId);
}

export function clearTaskRetargetTurnsForTest(): void {
  currentTurns.clear();
}
