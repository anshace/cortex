import { useEffect, useState } from "react";

import App from "./App";
import Loader from "./Loader";
import Login from "./Login";

type AuthState = "loading" | "out" | "in";

// Gates the entire app. Nothing but the login screen renders for an
// unauthenticated visitor — no shell, no data, no routes.
function AuthGate() {
  const [state, setState] = useState<AuthState>("loading");

  useEffect(() => {
    fetch("/api/me", { credentials: "include" })
      .then((res) => setState(res.ok ? "in" : "out"))
      .catch(() => setState("out"));
  }, []);

  if (state === "loading") {
    return <Loader />;
  }

  if (state === "out") {
    return <Login onSuccess={() => setState("in")} />;
  }

  return <App />;
}

export default AuthGate;
