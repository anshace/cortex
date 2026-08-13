import { useEffect, useState } from "react";

import * as api from "./api";
import { Me } from "./api";
import Loader from "./Loader";
import OwnerApp from "./OwnerApp";
import WorkspaceApp from "./WorkspaceApp";

function App() {
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api.getMe().then((m) => {
      if (!m) {
        window.location.reload();
        return;
      }
      setMe(m);
    });
  }, []);

  // Presence heartbeat while signed in, so teammates see us as online.
  useEffect(() => {
    if (!me) return;
    api.pingPresence();
    const id = window.setInterval(() => api.pingPresence(), 25000);
    return () => window.clearInterval(id);
  }, [me]);

  async function handleLogout() {
    await api.logout();
    window.location.reload();
  }

  const refresh = () => {
    api.getMe().then((m) => m && setMe(m));
  };

  if (!me) return <Loader />;

  // Root → hidden owner console; everyone else → their org's workspace app.
  return me.role === "root" ? (
    <OwnerApp me={me} onLogout={handleLogout} onUpdated={refresh} />
  ) : (
    <WorkspaceApp me={me} onLogout={handleLogout} onUpdated={refresh} />
  );
}

export default App;
