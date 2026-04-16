import Dashboard from "./routes/Dashboard.svelte";
import Login from "./routes/Login.svelte";
import Signup from "./routes/Signup.svelte";
import Settings from "./routes/Settings.svelte";
import NotFound from "./routes/NotFound.svelte";

const routes: Record<string, typeof Dashboard> = {
  "/": Dashboard,
  "/login": Login,
  "/signup": Signup,
  "/settings": Settings,
  "*": NotFound,
};

/** Routes that don't require authentication. */
export const publicRoutes = new Set(["/login", "/signup"]);

export default routes;
