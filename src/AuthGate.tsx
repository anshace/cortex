import { useEffect, useState } from "react";

import App from "./App";
import Landing from "./Landing";
import Loader from "./Loader";
import Login from "./Login";

type AuthState = "loading" | "out" | "in";

// Gates the entire app. Unauthenticated visitors get the public landing page;
// the login form (and nothing else — no shell, no data, no routes) appears
// only after they click Sign in.
function AuthGate() {
  const [state, setState] = useState<AuthState>("loading");
  const [showLogin, setShowLogin] = useState(false);

  useEffect(() => {
    fetch("/api/me", { credentials: "include" })
      .then((res) => setState(res.ok ? "in" : "out"))
      .catch(() => setState("out"));
  }, []);

  if (state === "loading") {
    return <Loader />;
  }

  if (state === "out") {
    return showLogin ? (
      <Login
        onBack={() => setShowLogin(false)}
        onSuccess={() => setState("in")}
      />
    ) : (
      <Landing onSignIn={() => setShowLogin(true)} />
    );
  }

  return <App />;
}

export default AuthGate;
