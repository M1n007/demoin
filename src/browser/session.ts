/**
 * Reads a sign-in session pasted by the user.
 *
 * This is the way out for sites whose sign-in page the agent cannot get past:
 * a captcha, a Google button, a code sent by SMS. The user signs in in their
 * own browser, copies the cookies, and the agent starts already signed in.
 *
 * Two forms are accepted, because those are what people actually have: a JSON
 * export from a cookie extension, and the `Cookie:` line copied from the
 * Network tab of the developer tools.
 */

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

const SAME_SITE: Record<string, SessionCookie["sameSite"]> = {
  strict: "Strict",
  lax: "Lax",
  none: "None",
  no_restriction: "None",
};

/** Cookie names that clearly are not a session. Carrying them only adds risk. */
const NOISE = /^(_ga|_gid|_gat|_fbp|_fbc|__utm|_hj|_clck|_clsk|ajs_|amplitude|mp_|intercom-|__gads|__gpi|NID|IDE|test_cookie)/i;

function hostOf(targetUrl: string): string {
  try {
    return new URL(targetUrl).hostname;
  } catch {
    return "";
  }
}

/** ".example.com" so subdomains like app.example.com are included. */
function defaultDomain(host: string): string {
  const parts = host.split(".");
  if (parts.length <= 2) return `.${host}`;
  return `.${parts.slice(-2).join(".")}`;
}

function normalize(
  raw: Record<string, unknown>,
  host: string,
): SessionCookie | null {
  const name = String(raw.name ?? raw.Name ?? "").trim();
  const value = String(raw.value ?? raw.Value ?? "");
  if (!name || !value) return null;

  let domain = String(raw.domain ?? raw.Domain ?? "").trim();
  if (!domain) domain = defaultDomain(host);

  const expRaw = raw.expirationDate ?? raw.expires ?? raw.Expires;
  const exp = typeof expRaw === "number" ? Math.floor(expRaw) : undefined;

  const ss = String(raw.sameSite ?? raw.SameSite ?? "").toLowerCase();
  const secure = Boolean(raw.secure ?? raw.Secure);
  const sameSite = SAME_SITE[ss];

  return {
    name,
    value,
    domain,
    path: String(raw.path ?? raw.Path ?? "/") || "/",
    ...(exp && exp > 0 ? { expires: exp } : {}),
    httpOnly: Boolean(raw.httpOnly ?? raw.HttpOnly),
    secure,
    // Browsers reject SameSite=None without Secure, so don't pass it on.
    ...(sameSite && (sameSite !== "None" || secure) ? { sameSite } : {}),
  };
}

function fromHeader(text: string, host: string): SessionCookie[] {
  const body = text.replace(/^\s*cookie\s*:\s*/i, "");
  const out: SessionCookie[] = [];
  for (const pair of body.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || !value) continue;
    out.push({ name, value, domain: defaultDomain(host), path: "/" });
  }
  return out;
}

/**
 * Returns cookies ready to be set. Throws if not a single one could be read:
 * better to fail up front than to record a video of a sign-in page that was
 * never actually passed.
 */
export function parseSession(raw: string, targetUrl: string): SessionCookie[] {
  const text = raw.trim();
  if (!text) return [];
  const host = hostOf(targetUrl);
  if (!host) throw new Error("The site URL is not valid yet, so the session cannot be applied");

  let list: SessionCookie[] = [];
  if (text.startsWith("[") || text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("The session looks like JSON but is incomplete. Copy it again from the extension.");
    }
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { cookies?: unknown }).cookies)
        ? ((parsed as { cookies: unknown[] }).cookies)
        : [parsed];
    list = arr
      .map((c) => normalize(c as Record<string, unknown>, host))
      .filter((c): c is SessionCookie => c !== null);
  } else {
    list = fromHeader(text, host);
  }

  const clean = list.filter((c) => !NOISE.test(c.name));
  if (!clean.length) {
    throw new Error("No cookies could be read from that text. Paste a cookie export or the Cookie line from the Network tab.");
  }
  return clean.slice(0, 60);
}

/** Summary for logs and the screen, without leaking the values. */
export const describeSession = (cookies: SessionCookie[]) =>
  `${cookies.length} session cookie${cookies.length === 1 ? "" : "s"}`;
