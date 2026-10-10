import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { authClient } from "./lib/auth.js";
import { AuthScreen } from "./screens/auth.js";
import { EditorScreen } from "./screens/editor.js";
import { ProjectsScreen } from "./screens/projects.js";

function Layout() {
  return (
    <div className="min-h-dvh">
      {/* Keyboard users should not have to tab through the chrome. */}
      <a
        href="#content"
        className="sr-only rounded-md bg-accent px-3 py-2 text-sm text-paper focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
      >
        Skip to content
      </a>
      <Outlet />
    </div>
  );
}

const rootRoute = createRootRoute({
  component: Layout,
  notFoundComponent: NotFound,
});

function NotFound() {
  return (
    <main
      id="content"
      className="panel-grid grid min-h-dvh place-items-center bg-paper px-4"
    >
      <div className="max-w-sm text-center">
        <p className="font-mono text-xs tracking-[0.22em] text-accent">404</p>
        <h1 className="mt-3 text-2xl font-medium text-ink">This square is empty</h1>
        <p className="mt-2 text-[13px] text-muted">
          The page you asked for is not part of this canvas.
        </p>
        <Link
          to="/projects"
          className="mt-6 inline-block min-h-11 rounded-md bg-accent px-4 py-2.5 text-sm text-paper"
        >
          Back to projects
        </Link>
      </div>
    </main>
  );
}

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

export const router = createRouter({ routeTree, defaultNotFoundComponent: NotFound });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
