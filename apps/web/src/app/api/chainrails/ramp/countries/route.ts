import { NextResponse, type NextRequest } from "next/server";

const API_URL = "https://api.chainrails.io/api/v1/ramp/countries";

/**
 * Chainrails' live country/currency catalogue for the ramp forms.
 *
 * Uses the plain REST endpoint (not the SDK) to match the other ramp routes —
 * the axios-based SDK was flaky here. The endpoint returns a bare array, which
 * we wrap as `{ countries }` for the client. We proxy from the server to keep
 * the API key off the browser.
 */
export async function GET(req: NextRequest) {
  const query =
    req.nextUrl.searchParams.get("type") === "off-ramp" ? "?type=off-ramp" : "";

  const apiKey = process.env.CHAINRAILS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "CHAINRAILS_API_KEY is not configured on the server." },
      { status: 500 }
    );
  }

  try {
    const upstream = await fetch(`${API_URL}${query}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    });
    const data: unknown = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      console.error(
        `[chainrails ramp countries] upstream ${upstream.status}:`,
        JSON.stringify(data)
      );
      const message =
        data && typeof data === "object" && "message" in data
          ? String((data as Record<string, unknown>).message)
          : `Couldn't load supported countries (${upstream.status}).`;
      return NextResponse.json({ error: message }, { status: upstream.status });
    }

    // The endpoint returns a bare array; wrap it for the client.
    const countries = Array.isArray(data) ? data : [];
    return NextResponse.json({ countries });
  } catch (error) {
    console.error("[chainrails ramp countries] request failed", error);
    return NextResponse.json(
      { error: "Couldn't reach Chainrails for supported countries." },
      { status: 502 }
    );
  }
}
