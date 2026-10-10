import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { authClient } from "./lib/auth.js";
import { AuthScreen } from "./screens/auth.js";
import { EditorScreen } from "./screens/editor.js";
import { ProjectsScreen } from "./screens/projects.js";

const rootRoute = createRootRoute({
  component: () => (
    <div className="min-h-screen">
      <Outlet />
    </div>
  ),
});

async function requireSession() {
  const session = await authClient.getSession();
  if (!session.data?.user) throw redirect({ to: "/login" });
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: () => <AuthScreen mode="login" />,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/register",
  component: () => <AuthScreen mode="register" />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: async () => {
    const session = await authClient.getSession();
    throw redirect({ to: session.data?.user ? "/projects" : "/login" });
  },
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects",
  beforeLoad: requireSession,
  component: ProjectsScreen,
});

const editorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId/assets/$assetId",
  beforeLoad: requireSession,
  component: EditorScreen,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  registerRoute,
  projectsRoute,
  editorRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
