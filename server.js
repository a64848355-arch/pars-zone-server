
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const players = new Map();

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Pars Zone Server is running!");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  let playerId = null;

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "join" && data.id) {
        playerId = String(data.id);
        players.set(playerId, {
          id: playerId,
          name: String(data.name || "بازیکن").slice(0, 24),
          x: 0,
          y: 0,
          z: 0,
          ws
        });

        ws.send(JSON.stringify({
          type: "welcome",
          id: playerId
        }));
      }

      if (data.type === "move" && playerId && players.has(playerId)) {
        const p = players.get(playerId);
        p.x = Number(data.x) || 0;
        p.y = Number(data.y) || 0;
        p.z = Number(data.z) || 0;
      }
    } catch (error) {
      console.error("Invalid message");
    }
  });

  ws.on("close", () => {
    if (playerId) {
      players.delete(playerId);
      broadcastPlayers();
    }
  });
});

function broadcastPlayers() {
  const list = [...players.values()].map(p => ({
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    z: p.z
  }));

  const message = JSON.stringify({
    type: "players",
    players: list
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

setInterval(broadcastPlayers, 100);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Pars Zone server listening on ${PORT}`);
});
