import type { TranscriptTurn } from "../types/appointmentExtraction";

export interface CallSession {
  callId: string;
  hospitalId: string;
  callerPhone: string | null;
  transcript: TranscriptTurn[];
  startTime: Date;
}

/**
 * In‑memory, per‑process call session manager.
 * One CallSession per active callId. Safe for concurrent calls within a single
 * Node.js process (all access is serialized in the event loop).
 */
export class CallSessionManager {
  private sessions = new Map<string, CallSession>();

  createSession(params: {
    callId: string;
    hospitalId: string;
    callerPhone: string | null;
  }): CallSession {
    const existing = this.sessions.get(params.callId);
    if (existing) {
      return existing;
    }
    const session: CallSession = {
      callId: params.callId,
      hospitalId: params.hospitalId,
      callerPhone: params.callerPhone,
      transcript: [],
      startTime: new Date(),
    };
    this.sessions.set(params.callId, session);
    return session;
  }

  getSession(callId: string): CallSession | undefined {
    return this.sessions.get(callId);
  }

  /**
   * Append a new transcript turn (user or assistant) to a call session.
   * If the session does not exist yet, this is a no‑op.
   */
  appendTranscript(callId: string, turn: TranscriptTurn): void {
    const session = this.sessions.get(callId);
    if (!session) return;
    session.transcript.push(turn);
  }

  /**
   * End a session and remove it from memory, returning the final snapshot.
   * Caller is responsible for triggering extraction + backend actions.
   */
  endSession(callId: string): CallSession | undefined {
    const session = this.sessions.get(callId);
    if (!session) return undefined;
    this.sessions.delete(callId);
    return session;
  }

  /**
   * For observability or cleanup: list all active sessions.
   */
  listActiveSessions(): CallSession[] {
    return Array.from(this.sessions.values());
  }
}

