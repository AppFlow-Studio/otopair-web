import { NextResponse } from "next/server";

/**
 * Returns a short-lived credential for connecting the browser to a PRIVATE
 * ElevenLabs Conversational AI agent.
 *
 * For a PUBLIC agent you don't need this route — the client connects directly
 * with NEXT_PUBLIC_ELEVENLABS_AGENT_ID.
 *
 * To enable a private agent, set in .env.local:
 *   ELEVENLABS_API_KEY=sk_...
 *   ELEVENLABS_AGENT_ID=agent_...   (server-side, no NEXT_PUBLIC_ prefix)
 */
export async function GET() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId =
    process.env.ELEVENLABS_AGENT_ID ?? process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;

  if (!apiKey || !agentId) {
    // No private-agent credentials configured. The client falls back to the
    // public agent id or the scripted demo.
    return NextResponse.json(
      { error: "ElevenLabs private agent not configured" },
      { status: 501 }
    );
  }

  try {
    // WebRTC: mint a conversation token.
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${agentId}`,
      { headers: { "xi-api-key": apiKey }, cache: "no-store" }
    );

    if (!res.ok) {
      const detail = await res.text();
      return NextResponse.json(
        { error: "Failed to mint conversation token", detail },
        { status: 502 }
      );
    }

    const data = (await res.json()) as { token?: string };
    return NextResponse.json({ conversationToken: data.token });
  } catch (err) {
    return NextResponse.json(
      { error: "ElevenLabs request failed", detail: String(err) },
      { status: 500 }
    );
  }
}
