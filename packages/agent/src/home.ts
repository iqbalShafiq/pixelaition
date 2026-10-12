/**
 * The home decision: Jev picks where a home prompt belongs, from the user's
 * live projects and assets and their generated summaries. One request asks
 * intent and project together; a second asks the asset when the project is
 * known and the intent draws. Uncertainty is not a failure — it becomes a
 * proposal the confirmation card shows and the user can override.
 */
import type { DrawIntent } from "./decide.js";
import { askJev, type JevAnswer, type JevEnv } from "./jev.js";

/** More options than this make the decision expensive; fail with a cause. */
export const HOME_PROJECT_LIMIT = 50;

export class HomeDecisionError extends Error {
  readonly code = "PROJECT_LIMIT_FOR_DECISION" as const;
  constructor(message: string) {
    super(message);
    this.name = "HomeDecisionError";
  }
}

export type HomeProjectOption = {
  id: string;
  name: string;
  summary: string;
  assetCount: number;
};

export type HomeAssetOption = {
  id: string;
  name: string;
  summary: string;
  width: number;
  height: number;
};

export type HomeHistoryEntry = { prompt: string; answer?: string };

export type HomeTarget = {
  intent: DrawIntent;
  project: { id: string | "new"; confidence: number };
  asset?: { id: string | "new"; confidence: number };
  source: "jev";
};

export type HomeContext = {
  projects: HomeProjectOption[];
  assetsByProject: Map<string, HomeAssetOption[]>;
  history?: HomeHistoryEntry[];
};

const intentOptions = {
  draw: "Draw a new sprite, item, or tile from scratch.",
  edit: "Change pixels or colors that already exist, including a follow-up that corrects the previous result.",
  variant: "Produce another state, direction, or action of an existing frame.",
  ask: "The user is asking a question, chatting about the work, or the message needs a reply instead of a drawing.",
} as const;

function optionText(name: string, summary: string, suffix: string): string {
  const described = summary.length > 0 ? `${name} — ${summary}` : name;
  return `${described} (${suffix})`;
}

function readIntent(answer: JevAnswer | undefined): DrawIntent {
  const choice = answer?.choice;
  return choice === "draw" || choice === "edit" || choice === "variant" ? choice : "ask";
}

export async function decideHomeTarget(
  prompt: string,
  env: JevEnv,
  context: HomeContext,
): Promise<HomeTarget> {
  if (context.projects.length > HOME_PROJECT_LIMIT) {
    throw new HomeDecisionError(
      `The home decision handles at most ${HOME_PROJECT_LIMIT} projects; this account has ${context.projects.length}.`,
    );
  }
  const projectCriteria: Record<string, string> = {};
  for (const project of context.projects) {
    projectCriteria[project.id] = optionText(
      project.name,
      project.summary,
      `${project.assetCount} assets`,
    );
  }
  projectCriteria.new = "Start a new project for this request";
  const history =
    context.history !== undefined && context.history.length > 0
      ? { history: context.history }
      : {};
  const first = await askJev(
    { prompt, projects: context.projects, ...history },
    {
      intent: {
        type: "choice",
        instructions:
          "Classify what the user is asking for. Prefer variant when the request names a direction, an action, or another state of a frame that already exists; a short noun phrase naming a new state or action is variant, not ask. Prefer ask when the message is a question or a remark that wants an answer, not a drawing.",
        criteria: intentOptions,
      },
      project: {
        type: "choice",
        instructions:
          "Which project should this request go to? Use each project's name and summary; pick `new` only when none of them fits the request.",
        criteria: projectCriteria,
      },
    },
    env,
  );
  const intent = readIntent(first.answers.intent);
  const projectChoice = first.answers.project?.choice;
  const projectId =
    projectChoice !== undefined &&
    (projectChoice === "new" ||
      context.projects.some((item) => item.id === projectChoice))
      ? projectChoice
      : "new";
  const project: HomeTarget["project"] = {
    id: projectId,
    confidence: first.answers.project?.confidence ?? 0,
  };
  if (intent === "ask" || projectId === "new") {
    return { intent, project, source: "jev" };
  }
  const assets = context.assetsByProject.get(projectId) ?? [];
  const assetCriteria: Record<string, string> = {};
  for (const asset of assets) {
    assetCriteria[asset.id] = optionText(
      asset.name,
      asset.summary,
      `${asset.width}×${asset.height}`,
    );
  }
  assetCriteria.new = "Create a new asset in this project";
  const second = await askJev(
    {
      prompt,
      project: context.projects.find((item) => item.id === projectId),
      assets,
      ...history,
    },
    {
      asset: {
        type: "choice",
        instructions:
          "Which asset of this project should the request change? Use each asset's name and summary; pick `new` only when none of them fits.",
        criteria: assetCriteria,
      },
    },
    env,
  );
  const assetChoice = second.answers.asset?.choice;
  const assetId =
    assetChoice !== undefined &&
    (assetChoice === "new" || assets.some((item) => item.id === assetChoice))
      ? assetChoice
      : "new";
  return {
    intent,
    project,
    asset: { id: assetId, confidence: second.answers.asset?.confidence ?? 0 },
    source: "jev",
  };
}
