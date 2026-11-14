import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

export interface ConnectedPeerMeta {
  device_id: string;
  platform: string;
  device_name: string;
  connected_at: string;
}

/**
 * Per-user Stateful Edge Coordinator using Cloudflare WebSocket Hibernation (`ctx.acceptWebSocket`).
 * Keeps thousands of iPhone, Mac, and Web peer sockets open at near-$0 idle cost, waking immediately
 * on incoming transfers, access requests, or macOS iMessage bridge jobs.
 */
export class UserRelayHub extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 1. WebSocket Upgrade from iPhone, macOS, or Web Client
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const deviceId = url.searchParams.get("device_id") || "dev_edge";
      const platform = url.searchParams.get("platform") || "web";
      const deviceName = url.searchParams.get("device_name") || "Fyde Client";

      const meta: ConnectedPeerMeta = {
        device_id: deviceId,
        platform,
        device_name: deviceName,
        connected_at: new Date().toISOString(),
      };

      this.ctx.acceptWebSocket(server, [deviceId, platform]);
      server.serializeAttachment(meta);

      server.send(
        JSON.stringify({
          event: "connected",
          payload: {
            device: meta,
            online_peers: this.listPeerAttachments(),
          },
        })
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. Internal Worker -> DO broadcast RPC (`/notify`)
    if (request.method === "POST" && url.pathname === "/notify") {
      const body = (await request.json()) as { event: string; payload: unknown };
      const msg = JSON.stringify(body);
      let delivered = 0;
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(msg);
          delivered++;
        } catch {
          try {
            ws.close(1011, "stale");
          } catch {
            // ignore
          }
        }
      }
      return Response.json({ delivered, peers: this.listPeerAttachments() });
    }

    // 3. Query online devices (e.g. check if user's macOS iMessage Bridge is online!)
    if (url.pathname === "/devices") {
      const peers = this.listPeerAttachments();
      const hasMacBridge = peers.some((p) => p.platform === "macos");
      return Response.json({ peers, has_mac_bridge: hasMacBridge });
    }

    return new Response("Not found", { status: 404 });
  }

  private listPeerAttachments(): ConnectedPeerMeta[] {
    const out: ConnectedPeerMeta[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const meta = ws.deserializeAttachment() as ConnectedPeerMeta | null;
      if (meta) out.push(meta);
    }
    return out;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    try {
      const parsed = JSON.parse(message) as { type?: string };
      if (parsed.type === "ping") {
        ws.send(JSON.stringify({ event: "pong", payload: { ts: new Date().toISOString() } }));
      }
    } catch {
      // ignore malformed frames
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // ignore
    }
  }
}
