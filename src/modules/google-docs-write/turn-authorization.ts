const TURN_MAX_AGE_MS = 30 * 60 * 1000;

interface AuthorizedTurn {
  sourceMessageId: string;
  userId: string | null;
  recordedAt: number;
}

type DenialCode = 'missing_turn' | 'expired_turn' | 'stale_message' | 'unauthorized_sender';

type TurnAuthorization = { allowed: true; userId: string } | { allowed: false; code: DenialCode; reason: string };

const currentTurns = new Map<string, AuthorizedTurn>();

/** Record the newest engaged inbound message for a session. Host process only. */
export function recordGoogleDocsWriteTurn(sessionId: string, sourceMessageId: string, userId: string | null): void {
  currentTurns.set(sessionId, { sourceMessageId, userId, recordedAt: Date.now() });
}

/**
 * Consume a one-shot write grant for the exact newest message in a session.
 * The caller still validates the source row and agent group before execution.
 */
export function consumeGoogleDocsWriteTurn(
  sessionId: string,
  sourceMessageId: string,
  allowedUsers: ReadonlySet<string>,
): TurnAuthorization {
  const turn = currentTurns.get(sessionId);
  if (!turn) {
    return {
      allowed: false,
      code: 'missing_turn',
      reason: 'no active user turn is authorized for document writes',
    };
  }

  const age = Date.now() - turn.recordedAt;
  if (!Number.isFinite(age) || age > TURN_MAX_AGE_MS) {
    currentTurns.delete(sessionId);
    return {
      allowed: false,
      code: 'expired_turn',
      reason: 'the document-write authorization expired; ask again in a new message',
    };
  }
  if (turn.sourceMessageId !== sourceMessageId) {
    return {
      allowed: false,
      code: 'stale_message',
      reason: 'the write request is not tied to the newest inbound message',
    };
  }
  if (!turn.userId || !allowedUsers.has(turn.userId)) {
    return {
      allowed: false,
      code: 'unauthorized_sender',
      reason: 'the Slack sender is not authorized to modify Google Docs',
    };
  }

  currentTurns.delete(sessionId);
  return { allowed: true, userId: turn.userId };
}

export function clearGoogleDocsWriteTurnsForTest(): void {
  currentTurns.clear();
}
