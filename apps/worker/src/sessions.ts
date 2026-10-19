/**
 * The durable session an ask run continues.
 *
 * The runtime continues a session's latest completed run whatever agent
 * produced it (`latestCompleted(sessionId)`), so a thread-wide session let
 * one model replay another model's turns. A conversation is only replayable
 * inside the api shape that produced it: the chat-completions adapter mints
 * its reasoning ids locally (a UUID used for streaming), and the responses
 * endpoint accepts only the ids it issued itself, answering
 *   "400 Invalid reasoning item id format. Expected an id returned on a
 *   reasoning output item."
 * One conversation per model and shape keeps every replay within the shape
 * that produced it; switching models starts a fresh conversation, and the
 * thread's drawing turns still ride the prompt as text.
 */
export function askSessionId(
  threadId: string,
  modelId: string,
  api: "chat" | "responses",
): string {
  return `${threadId}:ask:${modelId}:${api}`;
}
