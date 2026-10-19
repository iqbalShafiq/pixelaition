/**
 * The answer shapes a question card submits, plus the app's question-id
 * conventions: `project`, `asset`, `project_name`, and `asset_name` render as
 * live dropdowns or text fields instead of the model's short choice list.
 */

export type InteractionQuestion = {
  id: string;
  text: string;
  choices?: Array<{ label: string; value: string }>;
  allowCustom?: boolean;
};

export type AnswerState = { choice?: string; multi?: string[]; text: string };

const TARGET_QUESTION_IDS = ["project", "asset", "project_name", "asset_name"] as const;
export type TargetQuestionId = (typeof TARGET_QUESTION_IDS)[number];

export function isTargetQuestion(id: string): id is TargetQuestionId {
  return (TARGET_QUESTION_IDS as readonly string[]).includes(id);
}

/**
 * One string per question: typed text wins, otherwise the chosen value, with
 * `_multi` ids serialized as a JSON array string — the shape the worker parses.
 */
export function answerValue(
  question: InteractionQuestion,
  state: AnswerState | undefined,
): string {
  const text = state?.text.trim() ?? "";
  if (text !== "") return text;
  if (question.id.endsWith("_multi")) {
    const selected = state?.multi ?? [];
    return selected.length > 0 ? JSON.stringify(selected) : "";
  }
  return state?.choice ?? "";
}
