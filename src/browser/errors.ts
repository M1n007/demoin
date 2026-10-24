/**
 * Turns browser failures into sentences someone can act on.
 *
 * Playwright's raw messages are meant for developers, not users: they hold
 * call logs and net:: codes that mean nothing to someone who just wants their
 * video. The raw one is still kept in the technical log.
 */
export function friendlyNavError(raw: string, url: string): string {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* leave it as is */
  }

  const m = raw.toLowerCase();

  if (m.includes("err_name_not_resolved")) {
    return (
      `The address ${host} could not be found. It may be a typo, the domain ` +
      `may no longer be active, or it is blocked by the network demoin runs ` +
      `on. Make sure the site opens in a normal browser.`
    );
  }
  if (m.includes("err_connection_refused")) {
    return `${host} refused the connection. The server may be down or blocking outside access.`;
  }
  if (m.includes("err_connection_reset") || m.includes("err_empty_response")) {
    return `${host} dropped the connection halfway. Try again in a moment.`;
  }
  if (
    m.includes("err_connection_timed_out") ||
    m.includes("err_timed_out") ||
    m.includes("timeout")
  ) {
    return `${host} took too long to respond. The site may be slow or may not accept visits from abroad.`;
  }
  if (m.includes("err_cert") || m.includes("ssl")) {
    return `The security certificate of ${host} has a problem, so the page cannot be opened safely.`;
  }
  if (m.includes("err_too_many_redirects")) {
    return `${host} keeps redirecting in circles. This usually happens when the site needs a sign-in or rejects automated visitors.`;
  }
  if (m.includes("err_blocked_by") || m.includes("err_access_denied")) {
    return `Access to ${host} was blocked. The site may reject automated visits.`;
  }
  if (m.includes("err_internet_disconnected") || m.includes("err_network")) {
    return `The network connection dropped while opening ${host}. Try running it again.`;
  }
  if (m.includes("err_aborted")) {
    return `Opening ${host} was aborted halfway. Try running it again.`;
  }

  // Not recognised: still don't show the call log.
  const first = raw.split("\n")[0].replace(/^page\.\w+:\s*/, "").trim();
  return `Failed to open ${host}. ${first.slice(0, 160)}`;
}
