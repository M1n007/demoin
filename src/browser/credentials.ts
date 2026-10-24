/**
 * Credentials typed inside the goal.
 *
 * In production people write "make a demo of x.com email: a@b.com and
 * password secret" in the goal field instead of the Login panel. That has two
 * consequences:
 *
 * - The password is stored in the clear, shows up in logs, and is sent to
 *   the model at every step.
 * - The agent is not given credential placeholders, so it is unsure whether it
 *   may use those values, and a run ends "blocked by login" while the
 *   credentials are right in front of it.
 *
 * So before anything else, the email and password pair is moved into the
 * credential list, and in the goal it is replaced by the placeholders
 * {{EMAIL}} / {{PASSWORD}}.
 *
 * Only when the intent is to SIGN IN. A sign-up goal ("register with email
 * example@x.com") holds sample data to type into the sign-up form; turning
 * that into credentials would send the agent off looking for a sign-in page.
 */

export interface CredentialSplit {
  goal: string;
  credentials: { label: string; value: string }[];
}

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
/** password keyword, then an optional separator, then its value */
const PASSWORD = /\b(password|passwd|pass|pwd|pw|kata\s*sandi|sandi|kata\s*kunci)(?:nya)?\b\s*(?:adalah|is|:|=|-)?\s*(\S+)/i;
const USERNAME = /\b(username|user\s*name|user|nama\s*pengguna)(?:nya)?\b\s*(?:adalah|is|:|=|-)?\s*(\S+)/i;

export function splitCredentials(goal: string, existing: { label: string }[] = []): CredentialSplit {
  const text = goal ?? "";
  const signUp = /\b(daftar|registrasi|register|sign\s*up|buat\s+akun|akun\s+baru|create\s+(an\s+)?account|new\s+account)\b/i.test(text);
  const signIn = /\b(login|log\s*in|masuk|sign\s*in|dashboard|setelah\s+login|after\s+(logging\s+in|login|signing\s+in))\b/i.test(text);
  const pw = PASSWORD.exec(text);
  if (!pw || (signUp && !signIn)) return { goal: text, credentials: [] };

  const labels = new Set(existing.map((c) => c.label.toUpperCase()));
  const credentials: { label: string; value: string }[] = [];
  let g = text;

  // Sentence-ending punctuation is not part of the password,
  // unless the password really is only punctuation.
  const pwValue = pw[2].replace(/[.,;)]+$/, "") || pw[2];
  if (!labels.has("PASSWORD")) {
    credentials.push({ label: "PASSWORD", value: pwValue });
    g = g.replace(pw[0], `${pw[1]} {{PASSWORD}}`);
  }

  const email = EMAIL.exec(g);
  if (email && !labels.has("EMAIL")) {
    credentials.push({ label: "EMAIL", value: email[0] });
    g = g.split(email[0]).join("{{EMAIL}}");
  } else if (!email) {
    const user = USERNAME.exec(g);
    if (user && !labels.has("USERNAME") && !/\{\{/.test(user[2])) {
      credentials.push({ label: "USERNAME", value: user[2].replace(/[.,;)]+$/, "") });
      g = g.replace(user[0], `${user[1]} {{USERNAME}}`);
    }
  }

  return { goal: g, credentials };
}
