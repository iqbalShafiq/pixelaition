import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userPreferences = pgTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  lastModelId: text("last_model_id"),
  lastReasoningEffort: text("last_reasoning_effort"),
});

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** Generated, read-only: what this project holds, for decisions and prompts. */
  summary: text("summary").notNull().default(""),
  summaryAt: timestamp("summary_at", { withTimezone: true }),
  style: jsonb("style").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assets = pgTable("assets", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Generated, read-only: what this asset depicts. */
  summary: text("summary").notNull().default(""),
  summaryAt: timestamp("summary_at", { withTimezone: true }),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  palette: jsonb("palette").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const frames = pgTable(
  "frames",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Generated, read-only: what this frame shows. */
    summary: text("summary").notNull().default(""),
    summaryAt: timestamp("summary_at", { withTimezone: true }),
    index: integer("index").notNull(),
    layers: jsonb("layers").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("frames_asset_index").on(table.assetId, table.index)],
);

/**
 * A home prompt's decision, held between the proposal response and the
 * explicit confirm: the guardrail and Jev spend happens once, and the run
 * starts only from a consumed proposal.
 */
export const runProposals = pgTable("run_proposals", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  intent: text("intent").notNull(),
  projectId: text("project_id"),
  assetId: text("asset_id"),
  projectConfidence: real("project_confidence"),
  assetConfidence: real("asset_confidence"),
  guardrail: jsonb("guardrail"),
  decision: jsonb("decision"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export type VersionScope = "frame" | "asset";
export type VersionAuthor = "user" | "agent";

export const versions = pgTable(
  "versions",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    frameId: text("frame_id").references(() => frames.id, { onDelete: "cascade" }),
    scope: text("scope").$type<VersionScope>().notNull(),
    kind: text("kind").notNull(),
    author: text("author").$type<VersionAuthor>().notNull(),
    runId: text("run_id"),
    label: text("label"),
    snapshot: jsonb("snapshot").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("versions_asset_created").on(
      table.assetId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("versions_frame_id").on(table.frameId),
  ],
);

/**
 * A thread is one conversation. It hangs off an asset (editor runs) or, for a
 * workspace run that has not picked an asset yet, off its project. The check
 * keeps a thread from existing with no home at all.
 */
export const generationThreads = pgTable(
  "generation_threads",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id").references(() => assets.id, { onDelete: "cascade" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "generation_threads_scope",
      sql`${table.assetId} IS NOT NULL OR ${table.projectId} IS NOT NULL`,
    ),
  ],
);

export const generationMessages = pgTable("generation_messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id")
    .notNull()
    .references(() => generationThreads.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  parts: jsonb("parts").notNull(),
  modelId: text("model_id"),
  reasoningEffort: text("reasoning_effort"),
  traceId: text("trace_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const generationRuns = pgTable("generation_runs", {
  id: text("id").primaryKey(),
  threadId: text("thread_id")
    .notNull()
    .references(() => generationThreads.id, { onDelete: "cascade" }),
  durableRunId: text("durable_run_id"),
  requestId: text("request_id").notNull(),
  status: text("status").notNull(),
  modelId: text("model_id").notNull(),
  reasoningEffort: text("reasoning_effort").notNull(),
  frameId: text("frame_id"),
  prompt: text("prompt"),
  answer: text("answer"),
  errorCode: text("error_code"),
  events: jsonb("events"),
  override: jsonb("override"),
  /** Frames the user has approved for this run; survives a worker restart. */
  approvedScope: jsonb("approved_scope"),
  /** Token counts and USD cost the run spent, model and Jev split out. */
  usage: jsonb("usage"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const models = pgTable("models", {
  id: text("id").primaryKey(),
  api: text("api").notNull(),
  efforts: jsonb("efforts").notNull(),
  position: integer("position").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  vision: boolean("vision").notNull().default(false),
  maxOutputTokens: integer("max_output_tokens").notNull().default(8192),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userRelations = relations(user, ({ many, one }) => ({
  sessions: many(session),
  accounts: many(account),
  projects: many(projects),
  preferences: one(userPreferences, {
    fields: [user.id],
    references: [userPreferences.userId],
  }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const projectRelations = relations(projects, ({ one, many }) => ({
  user: one(user, { fields: [projects.userId], references: [user.id] }),
  assets: many(assets),
}));

export const assetRelations = relations(assets, ({ one, many }) => ({
  project: one(projects, { fields: [assets.projectId], references: [projects.id] }),
  frames: many(frames),
  versions: many(versions),
}));

export const frameRelations = relations(frames, ({ one }) => ({
  asset: one(assets, { fields: [frames.assetId], references: [assets.id] }),
}));

export const versionRelations = relations(versions, ({ one }) => ({
  asset: one(assets, { fields: [versions.assetId], references: [assets.id] }),
  frame: one(frames, { fields: [versions.frameId], references: [frames.id] }),
}));
