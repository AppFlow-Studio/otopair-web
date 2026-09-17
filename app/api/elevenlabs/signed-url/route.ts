import { NextRequest, NextResponse } from "next/server";

/**
 * Short-lived credential for connecting the browser to the PRIVATE Oto agent.
 * With agent auth on, an agent id alone is refused, so every session starts
 * here:
 *
 *   GET /api/elevenlabs/signed-url?mode=text   → { signedUrl }          (WebSocket, typed chat)
 *   GET /api/elevenlabs/signed-url?mode=voice  → { conversationToken }  (WebRTC, voice — default)
 *
 * The ElevenLabs SDK accepts a signed URL only over WebSocket and a
 * conversation token only over WebRTC, which is why the mode matters.
 *
 * Server-only env (never NEXT_PUBLIC_):
 *   ELEVENLABS_API_KEY=sk_...
 *   ELEVENLABS_AGENT_ID=agent_...
 *
 * Without them this returns 501 and the client falls back to a public agent
 * id (NEXT_PUBLIC_ELEVENLABS_AGENT_ID) or the scripted demo.
 */
export async function GET(request: NextRequest) {
  // Refuse cross-site browser requests. Scripts can still call this directly,
  // so it is a speed bump, not a lock — the agent's call limits are the real
  // ceiling on what anyone can spend.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId =
    process.env.ELEVENLABS_AGENT_ID ?? process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;

  if (!apiKey || !agentId) {
    return NextResponse.json(
      { error: "ElevenLabs private agent not configured" },
      { status: 501 }
    );
  }

  const mode = request.nextUrl.searchParams.get("mode") === "text" ? "text" : "voice";
  const endpoint =
    mode === "text"
      ? `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`
      : `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`;

  try {
    const res = await fetch(endpoint, {
      headers: { "xi-api-key": apiKey },
      cache: "no-store",
    });

    if (!res.ok) {
      // Log upstream detail server-side; don't echo it to the browser.
      console.error(`[elevenlabs] ${mode} credential failed: ${res.status} ${await res.text()}`);
      return NextResponse.json({ error: "Failed to start a conversation" }, { status: 502 });
    }

    const data = (await res.json()) as { signed_url?: string; token?: string };
    const body = mode === "text" ? { signedUrl: data.signed_url } : { conversationToken: data.token };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[elevenlabs] credential request failed:", err);
    return NextResponse.json({ error: "ElevenLabs request failed" }, { status: 500 });
  }
}
