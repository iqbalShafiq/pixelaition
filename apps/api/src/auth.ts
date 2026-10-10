import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { createDatabase, account, session, user, verification } from "@pixelaition/db";
import { betterAuth } from "better-auth";
import { requiredEnv, webOrigin } from "./env.js";

export const db = createDatabase();

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  secret: requiredEnv("BETTER_AUTH_SECRET"),
  baseURL: webOrigin(),
  trustedOrigins: [webOrigin()],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    autoSignIn: true,
  },
  rateLimit: {
    window: 60,
    max: 30,
    customRules: {
      "/sign-in/email": { window: 900, max: 10 },
      "/sign-up/email": { window: 900, max: 10 },
    },
  },
});
