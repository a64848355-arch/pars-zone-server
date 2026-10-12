
function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    }
  });
}

function token(size = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

function code() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}

function profile(data = {}, old = {}) {
  const n = (v, fallback = 0) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.max(0, x) : fallback;
  };

  const p = data.player_position || old.player_position || {};

  return {
    name: String(data.name ?? old.name ?? "بازیکن").trim().slice(0, 24),
    coins: n(data.coins, old.coins ?? 0),
    gems: n(data.gems, old.gems ?? 0),
    inventory: Array.isArray(data.inventory)
      ? data.inventory.slice(0, 100)
      : (old.inventory || []),
    car_owned: Boolean(data.car_owned ?? old.car_owned ?? false),
    player_position: {
      x: Number(p.x) || 0,
      y: Number(p.y) || 0,
      z: Number(p.z) || 0
    }
  };
}

export class GameRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.players = new Map();
    this.connections = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
        }
      });
    }

    if (path === "/" &&
        request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Pars Zone Server is running!");
    }

    if (path.startsWith("/account/") || path.startsWith("/transfer/")) {
      if (request.method !== "POST") {
        return reply({ ok: false, error: "POST required" }, 405);
      }

      let data;
      try {
        data = await request.json();
      } catch {
        return reply({ ok: false, error: "JSON نامعتبر است" }, 400);
      }

      if (path === "/account/create") {
        const id = crypto.randomUUID();
        const account = {
          accountId: id,
          token: token(),
          profile: profile(data.profile || {}),
          transferCode: null,
          transferExpiresAt: 0
        };

        await this.ctx.storage.put("account:" + id, account);

        return reply({
          ok: true,
          accountId: id,
          token: account.token,
          profile: account.profile
        });
      }

      if (path === "/transfer/redeem") {
        const submitted = String(data.code || "").trim().toUpperCase();
        const indexed = await this.ctx.storage.get("transfer:" + submitted);

        if (!indexed || indexed.expiresAt <= Date.now()) {
          return reply({ ok: false, error: "کد نامعتبر یا منقضی شده است" }, 401);
        }

        const account = await this.ctx.storage.get("account:" + indexed.accountId);

        if (!account || account.transferCode !== submitted) {
          return reply({ ok: false, error: "کد نامعتبر است" }, 401);
        }

        await this.ctx.storage.delete("transfer:" + submitted);
        account.token = token();
        account.transferCode = null;
        account.transferExpiresAt = 0;

        await this.ctx.storage.put("account:" + account.accountId, account);

        return reply({
          ok: true,
          accountId: account.accountId,
          token: account.token,
          profile: account.profile
        });
      }

      const id = String(data.accountId || "");
      const key = "account:" + id;
      const account = await this.ctx.storage.get(key);

      if (!account || account.token !== String(data.token || "")) {
        return reply({ ok: false, error: "اطلاعات حساب نادرست است" }, 401);
      }

      if (path === "/account/load") {
        return reply({ ok: true, profile: account.profile });
      }

      if (path === "/account/save") {
        account.profile = profile(data.profile || {}, account.profile);
        await this.ctx.storage.put(key, account);
        return reply({ ok: true });
      }

      if (path === "/transfer/create" || path === "/transfer/current") {
        if (path === "/transfer/current" &&
            account.transferCode &&
            account.transferExpiresAt > Date.now()) {
          return reply({
            ok: true,
            code: account.transferCode,
            expiresAt: account.transferExpiresAt
          });
        }

        if (account.transferCode) {
          await this.ctx.storage.delete("transfer:" + account.transferCode);
        }

        account.transferCode = code();
        account.transferExpiresAt = Date.now() + 60000;

        await this.ctx.storage.put(key, account);
        await this.ctx.storage.put("transfer:" + account.transferCode, {
          accountId: id,
          expiresAt: account.transferExpiresAt
        });

        return reply({
          ok: true,
          code: account.transferCode,
          expiresAt: account.transferExpiresAt
        });
      }

      return reply({ ok: false, error: "مسیر حساب پیدا نشد" }, 404);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return reply({ ok: false, error: "مسیر پیدا نشد" }, 404);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let player = null;

    server.addEventListener("message", event => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "join") {
          player = {
            id: String(data.id || crypto.randomUUID()),
            name: String(data.name || "بازیکن").slice(0, 24),
            x: 0,
            y: 0,
            z: 0
          };

          this.players.set(player.id, player);
          this.connections.set(player.id, server);

          server.send(JSON.stringify({ type: "welcome", id: player.id }));
          this.broadcast();
        }

        if (data.type === "move" && player) {
          player.x = Number(data.x) || 0;
          player.y = Number(data.y) || 0;
          player.z = Number(data.z) || 0;
          this.broadcast();
        }
      } catch {
        try {
          server.send(JSON.stringify({ type: "error", message: "پیام نامعتبر" }));
        } catch {}
      }
    });

    const remove = () => {
      if (!player) return;
      this.players.delete(player.id);
      this.connections.delete(player.id);
      player = null;
      this.broadcast();
    };

    server.addEventListener("close", remove);
    server.addEventListener("error", remove);

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast() {
    const message = JSON.stringify({
      type: "players",
      players: Array.from(this.players.values())
    });

    for (const [id, socket] of this.connections) {
      try {
        socket.send(message);
      } catch {
        this.connections.delete(id);
        this.players.delete(id);
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const room = env.ROOM.get(
      env.ROOM.idFromName("pars-zone-main")
    );
    return room.fetch(request);
  }
};
          
