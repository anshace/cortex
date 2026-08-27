import { getSession, resetSession, wsOpen, wsSeal } from "./crypto";

export type BoardUser = {
  name: string;
  hue: number;
};

export type BoardPresence = {
  pointer: { x: number; y: number; tool: "pointer" | "laser" } | null;
  button: "up" | "down";
  selected_element_ids: Record<string, boolean>;
};

export type BoardCollaborator = {
  username: string;
  color: { background: string; stroke: string };
  pointer?: BoardPresence["pointer"] extends infer Pointer
    ? Exclude<Pointer, null>
    : never;
  button: "up" | "down";
  selectedElementIds: Record<string, boolean>;
};

type ServerMessage = {
  Identity?: number;
  Snapshot?: {
    users: Record<number, BoardUser>;
    presence: Record<number, BoardPresence>;
  };
  User?: { id: number; info: BoardUser | null };
  Presence?: { id: number; data: BoardPresence };
  Scene?: { id: number; scene: unknown };
};

type Options = {
  uri: string;
  onCollaborators: (collaborators: Map<string, BoardCollaborator>) => void;
  onScene: (scene: unknown) => void | Promise<void>;
};

export default class BoardCollab {
  private ws?: WebSocket;
  private connecting = false;
  private disposed = false;
  private me = -1;
  private users: Record<number, BoardUser> = {};
  private presence: Record<number, BoardPresence> = {};
  private crypto?: { epk: string; key: CryptoKey };
  private sendQueue: string[] = [];
  private draining = false;
  private receiveQueue: string[] = [];
  private receiveDraining = false;
  private presenceTimer: number | null = null;
  private sceneTimer: number | null = null;
  private pendingScene: unknown;
  private localPresence: BoardPresence = {
    pointer: null,
    button: "up",
    selected_element_ids: {},
  };
  private readonly reconnectTimer: number;
  private connectionGeneration = 0;

  constructor(private readonly options: Options) {
    this.connect();
    this.reconnectTimer = window.setInterval(() => this.connect(), 1000);
  }

  dispose() {
    this.disposed = true;
    this.connectionGeneration += 1;
    window.clearInterval(this.reconnectTimer);
    if (this.presenceTimer != null) window.clearTimeout(this.presenceTimer);
    if (this.sceneTimer != null) window.clearTimeout(this.sceneTimer);
    this.ws?.close();
  }

  setPointer(pointer: BoardPresence["pointer"], button: "up" | "down") {
    this.localPresence = { ...this.localPresence, pointer, button };
    this.schedulePresence();
  }

  setSelection(selectedElementIds: Record<string, boolean>) {
    this.localPresence = {
      ...this.localPresence,
      selected_element_ids: selectedElementIds,
    };
    this.schedulePresence();
  }

  setScene(scene: unknown) {
    this.pendingScene = scene;
    if (this.sceneTimer != null) return;
    this.sceneTimer = window.setTimeout(() => {
      this.sceneTimer = null;
      if (this.pendingScene) {
        this.enqueue(JSON.stringify({ Scene: this.pendingScene }));
        this.pendingScene = undefined;
      }
    }, 40);
  }

  private async connect() {
    if (this.disposed || this.connecting || this.ws) return;
    this.connecting = true;
    const generation = ++this.connectionGeneration;
    const ws = new WebSocket(this.options.uri);

    ws.onopen = async () => {
      let session: Awaited<ReturnType<typeof getSession>>;
      try {
        session = await getSession();
      } catch {
        ws.close();
        return;
      }
      if (
        this.disposed ||
        generation !== this.connectionGeneration ||
        ws.readyState !== WebSocket.OPEN
      ) {
        ws.close();
        return;
      }
      this.crypto = session;
      this.connecting = false;
      this.ws = ws;
      this.users = {};
      this.presence = {};
      this.emitCollaborators();
      ws.send(JSON.stringify({ epk: this.crypto.epk }));
      this.enqueue(JSON.stringify({ Presence: this.localPresence }));
    };
    ws.onmessage = ({ data }) => {
      if (typeof data === "string") {
        this.receiveQueue.push(data);
        void this.drainReceive();
      }
    };
    ws.onclose = () => {
      if (generation !== this.connectionGeneration) return;
      if (this.ws === ws) this.ws = undefined;
      this.connecting = false;
      this.crypto = undefined;
      resetSession();
      this.sendQueue = [];
      this.users = {};
      this.presence = {};
      this.emitCollaborators();
    };
  }

  private schedulePresence() {
    if (this.presenceTimer != null) return;
    this.presenceTimer = window.setTimeout(() => {
      this.presenceTimer = null;
      this.enqueue(JSON.stringify({ Presence: this.localPresence }));
    }, 30);
  }

  private enqueue(message: string) {
    if (!this.ws || !this.crypto) return;
    this.sendQueue.push(message);
    void this.drainSend();
  }

  private async drainSend() {
    if (this.draining) return;
    this.draining = true;
    while (this.sendQueue.length && this.ws && this.crypto) {
      const message = this.sendQueue.shift()!;
      const ws = this.ws;
      const session = this.crypto;
      const generation = this.connectionGeneration;
      try {
        const envelope = await wsSeal(session.key, message);
        if (
          this.ws === ws &&
          this.crypto === session &&
          this.connectionGeneration === generation &&
          ws.readyState === WebSocket.OPEN
        ) {
          ws.send(JSON.stringify(envelope));
        }
      } catch {
        // Presence is ephemeral; the latest state is resent after reconnect.
      }
    }
    this.draining = false;
  }

  private async drainReceive() {
    if (this.receiveDraining) return;
    this.receiveDraining = true;
    while (this.receiveQueue.length) {
      const raw = this.receiveQueue.shift()!;
      if (!this.crypto) continue;
      try {
        const text = await wsOpen(this.crypto.key, JSON.parse(raw));
        await this.handleMessage(JSON.parse(text));
      } catch {
        // The server rotates its ECDH key on restart. Reconnect with a fresh
        // handshake instead of remaining attached with a stale cached key.
        resetSession();
        this.ws?.close();
      }
    }
    this.receiveDraining = false;
  }

  private async handleMessage(message: ServerMessage) {
    if (message.Identity !== undefined) {
      this.me = message.Identity;
      return;
    }
    if (message.Snapshot) {
      this.users = message.Snapshot.users;
      this.presence = message.Snapshot.presence;
      delete this.users[this.me];
      delete this.presence[this.me];
      this.emitCollaborators();
      return;
    }
    if (message.User) {
      const { id, info } = message.User;
      if (id === this.me) return;
      if (info) this.users[id] = info;
      else {
        delete this.users[id];
        delete this.presence[id];
      }
      this.emitCollaborators();
      return;
    }
    if (message.Presence) {
      const { id, data } = message.Presence;
      if (id === this.me) return;
      this.presence[id] = data;
      this.emitCollaborators();
      return;
    }
    if (message.Scene && message.Scene.id !== this.me) {
      await this.options.onScene(message.Scene.scene);
    }
  }

  private emitCollaborators() {
    const collaborators = new Map<string, BoardCollaborator>();
    for (const [rawId, user] of Object.entries(this.users)) {
      const data = this.presence[Number(rawId)];
      const color = `hsl(${user.hue}, 65%, 55%)`;
      collaborators.set(rawId, {
        username: user.name,
        color: { background: color, stroke: color },
        pointer: data?.pointer ?? undefined,
        button: data?.button ?? "up",
        selectedElementIds: data?.selected_element_ids ?? {},
      });
    }
    this.options.onCollaborators(collaborators);
  }
}
