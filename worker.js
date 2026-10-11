export class GameRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.players = new Map();
    this.connections = new Map();
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();

    let player = null;

    server.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);

        if (url.pathname === "/" && request.headers.get("Upgrade") !== "websocket") {
          player = {
            id: String(data.id || crypto.randomUUID()),
            name: String(data.name || "بازیکن").slice(0, 24),
            x: 0,
            y: 0,
            z: 0
          };

          this.players.set(player.id, player);
          this.connections.set(player.id, server);

          server.send(JSON.stringify({
            type: "welcome",
            id: player.id
          }));

          this.broadcast();
        }

        if (data.type === "move" && player) {
          player.x = Number(data.x) || 0;
          player.y = Number(data.y) || 0;
          player.z = Number(data.z) || 0;
          this.broadcast();
        }
      } catch (error) {
        server.send(JSON.stringify({ type: "error", message: "پیام نامعتبر" }));
      }
    });

    server.addEventListener("close", () => {
      if (player) {
        this.players.delete(player.id);
        this.connections.delete(player.id);
        this.broadcast();
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast() {
    const message = JSON.stringify({
      type: "players",
      players: Array.from(this.players.values())
    });

    for (const socket of this.connections.values()) {
      try {
        socket.send(message);
      } catch (error) {}
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response("Pars Zone Server is running!");
    }

    const room = env.ROOM.get(
      env.ROOM.idFromName("pars-zone-main")
    );

    return room.fetch(request);
  }
};
