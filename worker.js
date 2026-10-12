
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    }
  });

function randomToken(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, b => b.toString(16).padStart(2, "0")).join("");
}

function newTransferCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, b => chars[b % chars.length]).join("");
}

function cleanProfile(input = {}, old = {}) {
  const number = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, n) : fallback;
  };

  return {
    name: String(input.name ?? old.name ?? "بازیکن").trim().slice(0, 24),
    coins: number(input.coins, old.coins ?? 0),
    gems: number(input.gems, old.gems ?? 0),
    inventory: Array.isArray(input.inventory)
      ? input.inventory.slice(0, 100)
      : (old.inventory ?? []),
    car_owned: Boolean(input.car_owned ?? old.car_owned ?? false),
    player_position: input.player_position &&
      typeof input.player_position === "object"
      ? {
          x: Number(input.player_position.x) || 0,
          y: Number(input.player_position.y) || 0,
          z: Number(input.player_position.z) || 0
        }
      : (old.player_position ?? { x: 0, y: 0, z: 0 })
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

    if (path.startsWith("/account/") ||
        path.startsWith("/transfer/")) {
      if (request.method !== "POST") {
        return json({ ok: false, error: "POST required" }, 405);
      }

      let data;
      try {
        data = await request.json();
      } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
      }

      if (path === "/account/create") {
        const accountId = crypto.randomUUID();
        const token = randomToken();

        const account = {
          accountId,
          token,
          profile: cleanProfile(data.profile || {}),
          transferCode: null,
          transferExpiresAt: 0,
          createdAt: Date.now()
        };

        await this.ctx.storage.put("account:" + accountId, account);

        return json({
          ok: true,
          accountId,
          token,
          profile: account.profile
        });
      }

      const accountId = String(data.accountId || "");
      const token = String(data.token || "");

      if (path === "/account/load" || path === "/account/save" ||
          path === "/transfer/create" ||
          path === "/transfer/current") {
        if (!accountId || !token) {
          return json({ ok: false, error: "Missing credentials" }, 400);
        }

        const account = await this.ctx.storage.get("account:" + accountId);

        if (!account || account.token !== token) {
          return json({ ok: false, error: "Invalid account credentials" }, 401);
        }

        if (path === "/account/load") {
          return json({ ok: true, profile: account.profile });
        }

        if (path === "/account/save") {
          account.profile = cleanProfile(data.profile || {}, account.profile);
          await this.ctx.storage.put("account:" + accountId, account);
          return json({ ok: true });
        }

        if (path === "/transfer/create") {
          await this.rotateCode(account);
          return json({
            ok: true,
            code: account.transferCode,
            expiresAt: account.transferExpiresAt
          });
        }

        if (path === "/transfer/current") {
          if (!account.transferCode ||
              account.transferExpiresAt <= Date.now()) {
            await this.rotateCode(account);
          }

          return json({
            ok: true,
            code: account.transferCode,
            expiresAt: account.transferExpiresAt
          });
        }
      }

      if (path === "/transfer/redeem") {
        const code = String(data.code || "").trim().toUpperCase();

        if (!code) {
          return json({ ok: false, error: "Code required" }, 400);
        }

        const index = await this.ctx.storage.get("transfer:" + code);

        if (!index || index.expiresAt <= Date.now()) {
          return json({
            ok: false,
            error: "کد نامعتبر یا منقضی شده است"
          }, 401);
        }

        const account = await this.ctx.storage.get(
          "account:" + index.accountId
        );

        if (!account ||
            account.transferCode !== code ||
            account.transferExpiresAt <= Date.now()) {
          return json({
            ok: false,
            error: "کد نامعتبر یا منقضی شده است"
          }, 401);
        }

        await this.ctx.storage.delete("transfer:" + code);

        account.token = randomToken();
        account.transferCode = null;
        account.transferExpiresAt = 0;

        await this.ctx.storage.put(
          "account:" + account.accountId,
          account
        );

        return json({
          ok: true,
          accountId: account.accountId,
          token: account.token,
          profile: account.profile
        });
      }

      return json({ ok: false, error: "Unknown endpoint" }, 404);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ ok: false, error: "WebSocket required" }, 426);
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
      } catch {
        try {
          server.send(JSON.stringify({
            type: "error",
            message: "پیام نامعتبر"
          }));
        } catch {}
      }
    });

    const removePlayer = () => {
      if (player) {
        this.players.delete(player.id);
        this.connections.delete(player.id);
        player = null;
        this.broadcast();
      }
    };

    server.addEventListener("close", removePlayer);
    server.addEventListener("error", removePlayer);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async rotateCode(account) {
    if (account.transferCode) {
      await this.ctx.storage.delete(
        "transfer:" + account.transferCode
      );
    }

    account.transferCode = newTransferCode();
    account.transferExpiresAt = Date.now() + 60000;

    await this.ctx.storage.put(
      "account:" + account.accountId,
      account
    );

    await this.ctx.storage.put(
      "transfer:" + account.transferCode,
      {
        accountId: account.accountId,
        expiresAt: account.transferExpiresAt
      }
    );

    await this.ctx.storage.setAlarm(account.transferExpiresAt);
  }

  async alarm() {
    const now = Date.now();
    const accounts = await this.ctx.storage.list({
      prefix: "account:"
    });

    let nextExpiry = Infinity;

    for (const [key, account] of accounts) {
      if (!account.transferCode) continue;

      if (account.transferExpiresAt <= now) {
        await this.ctx.storage.delete(
          "transfer:" + account.transferCode
        );

        account.transferCode = newTransferCode();
        account.transferExpiresAt = now + 60000;

        await this.ctx.storage.put(key, account);

        await this.ctx.storage.put(
          "transfer:" + account.transferCode,
          {
            accountId: account.accountId,
            expiresAt: account.transferExpiresAt
          }
        );
      }

      nextExpiry = Math.min(nextExpiry, account.transferExpiresAt);
    }

    if (nextExpiry !== Infinity) {
      await this.ctx.storage.setAlarm(nextExpiry);
    }
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
        
