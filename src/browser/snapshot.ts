import type { Page } from "playwright-core";
import type { PageSnapshot, SnapEl } from "../types.js";

export const REF_ATTR = "data-demoin-ref";

/**
 * Collect the interactive elements plus a summary of the page text.
 * Every element gets a `data-demoin-ref` attribute so the executor can find
 * it again without relying on brittle selectors.
 */
export async function snapshotPage(page: Page, maxElements = 70): Promise<PageSnapshot> {
  return page.evaluate(
    ({ refAttr, limit }) => {
      const INTERACTIVE = [
        "a[href]",
        "button",
        "input",
        "select",
        "textarea",
        "summary",
        '[role="button"]',
        '[role="link"]',
        '[role="tab"]',
        '[role="menuitem"]',
        '[role="option"]',
        '[role="checkbox"]',
        '[role="switch"]',
        "[onclick]",
        '[contenteditable="true"]',
      ].join(",");

      document
        .querySelectorAll(`[${refAttr}]`)
        .forEach((el) => el.removeAttribute(refAttr));

      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const clean = (s: string | null | undefined) =>
        (s ?? "").replace(/\s+/g, " ").trim();

      /**
       * A label that stands NEXT TO its field instead of wrapping it.
       *
       * The most common Tailwind pattern: <div><label>Business Name</label><div><input
       * placeholder="My Shop"></div></div>, with no `for` attribute. Without this
       * sweep the field's name falls back to the placeholder, and the agent reads
       * "My Shop" as if the field were already filled. On a POS sign-up form the result was
       * the agent pressing Sign up over and over with Business Name empty, because
       * no element in the list was called "Business Name" that could be matched
       * against the message "Business name is required".
       *
       * Climbs at most four levels, and stops as soon as the container holds
       * another field: a label in that container belongs to its neighbour.
       */
      const CONTROL =
        "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]),select,textarea";
      const nearbyLabel = (el: Element): string => {
        let up: Element | null = el.parentElement;
        for (let k = 0; k < 4 && up && up !== document.body; k++, up = up.parentElement) {
          if (up.querySelectorAll(CONTROL).length > 1) break;
          // A section heading describes the whole section, not this field.
          // The search box under "Best Sellers" is still called "Search products".
          if (up.querySelector("h1,h2,h3,h4,h5,h6,[role='heading']")) break;
          const lab = up.querySelector("label,legend");
          const t = clean(lab?.textContent);
          if (t && t.length <= 80) return t;
          // Plain text that precedes its field: <p>Name</p><div><input></div>.
          // Only close by; the higher up, the less likely it is the label.
          if (k > 1) continue;
          for (const c of Array.from(up.children)) {
            if (c.contains(el)) break;
            const tt = clean((c as HTMLElement).innerText);
            if (tt && tt.length <= 60) return tt;
          }
        }
        return "";
      };

      const nameOf = (el: Element): string => {
        const he = el as HTMLElement;
        const aria = clean(el.getAttribute("aria-label"));
        if (aria) return aria;

        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
          const parts = labelledby
            .split(/\s+/)
            .map((id) => clean(document.getElementById(id)?.textContent))
            .filter(Boolean);
          if (parts.length) return parts.join(" ");
        }

        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
          const byFor = el.id
            ? clean(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent)
            : "";
          if (byFor) return byFor;
          const wrap = clean(el.closest("label")?.textContent);
          if (wrap) return wrap;
          const near = nearbyLabel(el);
          if (near) return near;
          if (el instanceof HTMLSelectElement) return clean(el.getAttribute("name"));
          const ph = clean(el.getAttribute("placeholder"));
          if (ph) return ph;
          const nm = clean(el.getAttribute("name"));
          if (nm) return nm;
        }

        /**
         * A close button must be called close.
         *
         * Without this it falls through to the name guessing below and inherits
         * its dialog's title, so the agent reads "Apply for a therapist account"
         * when what it is about to press is the closing cross. The agent then
         * confidently closes the very dialog that holds its goal, and the whole
         * demo is wasted.
         */
        const hint = `${el.getAttribute("class") ?? ""} ${el.getAttribute("data-testid") ?? ""}`;
        const txt = clean(he.innerText || el.textContent);
        if (/(^|[-_ ])(close|dismiss|tutup)([-_ ]|$)/i.test(hint)) return "Close";
        if (/^[×✕✖⨯x]$/i.test(txt)) return "Close";
        if (txt) return txt.slice(0, 90);

        // Controls with no text inside (checkbox, switch, icon button) are
        // described by the label around them. That label does not always wrap
        // them: Tailwind's "peer" pattern puts it next to them as a sibling, so
        // the wrappers are climbed a few levels until there is some text.
        const wrapLabel = clean(el.closest("label")?.textContent);
        if (wrapLabel) return wrapLabel.slice(0, 90);

        /**
         * A button whose content is only an icon.
         *
         * Guessing its name from the surrounding text is dangerous: what comes
         * along is usually the title or content of the whole card, and the agent
         * comes to believe the button does something completely different. It is
         * more honest to say what it is and let its shape and position explain
         * it. A small square inside a popup is almost always its close button.
         */
        const box = el.getBoundingClientRect();
        const ratio = box.width / Math.max(box.height, 1);
        const iconOnly =
          el.querySelector("svg,img,i") !== null &&
          ratio > 0.65 &&
          ratio < 1.55 &&
          box.width >= 18 &&
          box.width <= 84;
        if (iconOnly) return "";

        // Climb looking for nearby text, BUT stop at a container that has a
        // heading: heading text describes the whole section, not this control.
        // Tailwind's "peer" pattern, the reason this walk exists, never puts a
        // heading between the label and its input.
        let up: Element | null = el.parentElement;
        for (let i = 0; i < 3 && up; i++, up = up.parentElement) {
          if (up.querySelector("h1,h2,h3,h4,h5,h6,[role='heading']")) break;
          const t = clean((up as HTMLElement).innerText);
          if (t && t.length <= 120) return t.slice(0, 90);
        }

        const img = el.querySelector("img[alt]");
        if (img) {
          const alt = clean(img.getAttribute("alt"));
          if (alt) return alt;
        }
        const title = clean(el.getAttribute("title"));
        if (title) return title;
        if (el instanceof HTMLAnchorElement) {
          try {
            return new URL(el.href).pathname.slice(0, 60);
          } catch {
            /* ignore */
          }
        }
        return "";
      };

      /**
       * The box the user can actually see for this element.
       *
       * Modern UI libraries hide the real checkbox/radio input (1px in size or
       * opacity 0) and draw a decorative circle through the label instead. Taking
       * the element's own box as is makes the control vanish from the list, and
       * the agent has no way to tick a consent box even when that is the only
       * way to the goal.
       */
      const visualRect = (el: Element): DOMRect => {
        const own = el.getBoundingClientRect();
        if (own.width >= 6 && own.height >= 6) return own;
        const isBox =
          el instanceof HTMLInputElement &&
          (el.type === "checkbox" || el.type === "radio");
        if (!isBox) return own;
        const lab =
          (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) ||
          el.closest("label");
        const r = lab?.getBoundingClientRect();
        return r && r.width > 6 && r.height > 6 ? r : own;
      };

      const visible = (el: Element, r: DOMRect) => {
        if (r.width < 3 || r.height < 3) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") return false;
        // checkbox/radio inputs are hidden on purpose by UI libraries: what
        // counts is their stand-in label, not the real input
        const proxied =
          el instanceof HTMLInputElement &&
          (el.type === "checkbox" || el.type === "radio");
        if (!proxied && Number(cs.opacity) < 0.05) return false;
        if (el.getAttribute("aria-hidden") === "true") return false;
        // drop what is far outside the viewport (above/below)
        if (r.bottom < -300 || r.top > vh + 900) return false;
        if (r.right < 0 || r.left > vw) return false;
        return true;
      };

      /**
       * The nearest meaningful visual container: the card, form or dialog that
       * wraps this element. Used to frame the camera.
       *
       * Framing the raw element crops its card: an input sits inside a card that
       * is much wider, and moving in on the input alone cuts off the card's
       * edges. What means something to the viewer is the whole form, not just
       * its text box.
       */
      const groupOf = (el: Element, own: DOMRect) => {
        const screen = vw * vh;
        let n: Element | null = el.parentElement;
        let hops = 0;
        while (n && n !== document.body && hops++ < 8) {
          const r = n.getBoundingClientRect();
          if (r.width < 40 || r.height < 28) {
            n = n.parentElement;
            continue;
          }
          if (r.width * r.height > screen * 0.8) break; // already screen-sized
          const cs = getComputedStyle(n);
          const skinned =
            n.tagName === "FORM" ||
            n.getAttribute("role") === "dialog" ||
            (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") ||
            parseFloat(cs.borderTopWidth) > 0 ||
            cs.boxShadow !== "none";
          if (skinned && r.width >= own.width * 1.15) {
            return {
              x: Math.round(r.x * 10) / 10,
              y: Math.round(r.y * 10) / 10,
              w: Math.round(r.width * 10) / 10,
              h: Math.round(r.height * 10) / 10,
            };
          }
          n = n.parentElement;
        }
        return undefined;
      };

      type SnapEl = {
        ref: string;
        tag: string;
        role: string;
        name: string;
        type?: string;
        value?: string;
        placeholder?: string;
        rect: { x: number; y: number; w: number; h: number };
        group?: { x: number; y: number; w: number; h: number };
        inView: boolean;
        inDialog?: boolean;
        required?: boolean;
        thirdParty?: boolean;
        iconBtn?: boolean;
        clickable?: boolean;
        disabled?: boolean;
        active?: boolean;
      };

      /**
       * A menu item that points at the page that is CURRENTLY open.
       *
       * The agent sees "Home" in the bottom bar and clicks it, while it is
       * already on Home. In the video that shows as the camera moving in, a
       * finger tapping, and then nothing happening. The markers vary:
       * aria-current, a selected tab, data-state="active", a link whose address
       * equals the current address, or an "active" class inside a navigation.
       */
      const herePath = location.pathname.replace(/\/+$/, "") || "/";
      const isActive = (el: Element): boolean => {
        const cur = el.getAttribute("aria-current");
        if (cur && cur !== "false") return true;
        const role = el.getAttribute("role");
        if (role === "tab" && el.getAttribute("aria-selected") === "true") return true;
        if (el.getAttribute("data-state") === "active" || el.hasAttribute("data-active") && el.getAttribute("data-active") !== "false") return true;
        if (el instanceof HTMLAnchorElement && el.getAttribute("href") && !/^(#|javascript:)/i.test(el.getAttribute("href")!)) {
          try {
            const u = new URL(el.href, location.href);
            if (u.origin === location.origin && (u.pathname.replace(/\/+$/, "") || "/") === herePath && u.search === location.search && !u.hash)
              return true;
          } catch {
            /* odd href */
          }
        }
        const inNav = el.closest("nav,[role=navigation],[role=tablist],header,aside,footer");
        if (inNav && /(^|[\s_-])(active|is-active|current|selected)($|[\s_-])/i.test((el as HTMLElement).className?.toString?.() ?? ""))
          return true;
        return false;
      };

      const seen = new Set<string>();
      const elements: SnapEl[] = [];

      let i = 0;
      const nodes = Array.from(document.querySelectorAll(INTERACTIVE));
      for (const el of nodes) {
        if (elements.length >= limit) break;
        const r = visualRect(el);
        if (!visible(el, r)) continue;

        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute("type") ?? undefined;
        if (tag === "input" && (type === "hidden" || type === "file")) continue;

        const name = nameOf(el);
        const role = el.getAttribute("role") ?? tag;

        // drop exact duplicates (nav repeated in header and footer, etc.)
        const key = `${tag}|${role}|${name}|${Math.round(r.x)}|${Math.round(r.y)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        /**
         * Elements without a name are NOT dropped automatically when their role
         * matters.
         *
         * A consent checkbox is often an empty <button role="checkbox"> with no
         * text. Dropping it leaves the agent no way to accept the terms, and the
         * only button left in the dialog is "Close", so the demo ends by closing
         * the very thing it was looking for.
         */
        const keyRole = ["checkbox", "radio", "switch", "tab", "menuitem", "option"].includes(
          role,
        );
        const formish = tag === "input" || tag === "textarea" || tag === "select";

        /**
         * Nameless icon buttons are kept.
         *
         * Dropping them means the close button of a promo popup never reaches
         * the agent, and that popup covers the rest of the video with not a
         * single way out to choose from.
         */
        const elBox = visualRect(el);
        const elRatio = elBox.width / Math.max(elBox.height, 1);
        const iconBtn =
          !name &&
          (tag === "button" || role === "button" || tag === "a") &&
          el.querySelector("svg,img,i") !== null &&
          elRatio > 0.65 &&
          elRatio < 1.55 &&
          elBox.width >= 18 &&
          elBox.width <= 84;

        if (!name && !keyRole && !formish && !iconBtn) continue;

        const ref = `e${++i}`;
        el.setAttribute(refAttr, ref);

        let value: string | undefined;
        if (
          el instanceof HTMLInputElement &&
          (el.type === "checkbox" || el.type === "radio")
        ) {
          value = el.checked ? "checked" : "unchecked";
        } else if (el instanceof HTMLInputElement) {
          value = type === "password" ? (el.value ? "••••" : "") : el.value.slice(0, 60);
        } else if (el instanceof HTMLTextAreaElement) {
          value = el.value.slice(0, 60);
        } else if (keyRole) {
          const st = el.getAttribute("aria-checked") ?? el.getAttribute("aria-selected");
          if (st) value = st === "true" ? "checked" : "unchecked";
        } else if (el instanceof HTMLSelectElement) {
          value = el.options[el.selectedIndex]?.text?.slice(0, 60);
        }

        const off =
          (el as HTMLElement).hasAttribute("disabled") ||
          el.getAttribute("aria-disabled") === "true";

        /**
         * Required field. This is what separates "must be filled to continue"
         * from "may be filled if you like", and that difference decides what is
         * worth putting in the video and what only makes it longer.
         */
        const required =
          (el as HTMLElement).hasAttribute("required") ||
          el.getAttribute("aria-required") === "true" ||
          /\*\s*$/.test(name);

        const ph =
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
            ? clean(el.getAttribute("placeholder")).slice(0, 40)
            : "";

        elements.push({
          ref,
          tag,
          role,
          name,
          type,
          value,
          placeholder: ph || undefined,
          iconBtn: iconBtn || undefined,
          required: required || undefined,
          disabled: off || undefined,
          rect: {
            x: Math.round(r.x * 10) / 10,
            y: Math.round(r.y * 10) / 10,
            w: Math.round(r.width * 10) / 10,
            h: Math.round(r.height * 10) / 10,
          },
          group: groupOf(el, r),
          inView: r.top < vh && r.bottom > 0,
          active: (tag === "a" || tag === "button" || role === "tab" || role === "menuitem" || role === "link") && isActive(el) ? true : undefined,
        });
      }

      /**
       * Second sweep: things that can be clicked but don't say so.
       *
       * Modern frameworks attach click handlers through addEventListener, not
       * an onclick attribute, and often use a plain div with no role. Search
       * boxes, product cards, tabs and home-made menus become completely
       * invisible to the first sweep. What happens then is not the agent
       * picking wrong, but the agent picking from a list that simply does not
       * contain what it is looking for, and pressing its nearest neighbour.
       *
       * The only hint left, and a fairly reliable one: designers give
       * cursor:pointer to things that are meant to be clicked.
       */
      for (const el of Array.from(document.querySelectorAll("div,span,li,section,article"))) {
        if (i >= limit) break;
        if (el.hasAttribute(refAttr)) continue;
        if (getComputedStyle(el).cursor !== "pointer") continue;
        // Take the outermost of a pointer chain, that is the real click target.
        const pointerParent =
          el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer";
        if (pointerParent) continue;
        // Already wraps something the first sweep caught, don't double up.
        if (el.querySelector(`[${refAttr}]`)) continue;
        if (el.closest(`[${refAttr}]`)) continue;

        const r = visualRect(el);
        if (!visible(el, r)) continue;
        if (r.width < 24 || r.height < 16) continue;
        if (r.width * r.height > vw * vh * 0.5) continue;

        const name = nameOf(el);
        if (!name) continue;

        const key = `${name}|${Math.round(r.x)}|${Math.round(r.y)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const ref = `e${++i}`;
        el.setAttribute(refAttr, ref);
        elements.push({
          ref,
          tag: el.tagName.toLowerCase(),
          role: "button",
          name,
          clickable: true,
          rect: {
            x: Math.round(r.x * 10) / 10,
            y: Math.round(r.y * 10) / 10,
            w: Math.round(r.width * 10) / 10,
            h: Math.round(r.height * 10) / 10,
          },
          group: groupOf(el, r),
          inView: r.top < vh && r.bottom > 0,
          active: isActive(el) || undefined,
        });
      }

      const text = clean(document.body?.innerText).slice(0, 2600);

      // Whether a dialog/modal is open. Used for two things: telling the agent
      // its focus is now inside the dialog, and telling the camera to pull back
      // first so the viewer sees the whole dialog before it is approached again.
      /**
       * Promo popups almost never use role="dialog".
       *
       * All they use is a position:fixed div that covers the screen. If only
       * semantic markers are looked for, such a popup is never read as an
       * obstacle, and its close button is never marked.
       */
      const marked = Array.from(
        document.querySelectorAll(
          '[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]',
        ),
      ).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 120 && r.height > 80;
      });

      const screenArea = vw * vh;
      const largeFloating: Element[] = [];
      /** A dark layer covering the page. This is the sign the page is really blocked. */
      let hasBackdrop = false;

      for (const el of Array.from(document.querySelectorAll("body *"))) {
        const cs = getComputedStyle(el);
        if (cs.position !== "fixed") continue;
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        if (Number(cs.opacity) < 0.2) continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < screenArea * 0.28) continue;
        if (r.width < 200 || r.height < 200) continue;

        const bg = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
        if (bg) {
          const parts = bg[1].split(",").map((n) => Number(n));
          const alpha = parts.length > 3 ? parts[3] : 1;
          const dark = parts[0] + parts[1] + parts[2] < 480;
          if (alpha > 0.15 && alpha < 0.97 && dark && r.width * r.height > screenArea * 0.6) {
            hasBackdrop = true;
          }
        }
        if (el.querySelector("button,a,[role=button]")) largeFloating.push(el);
      }

      /**
       * Every layer is collected, not only the topmost.
       *
       * A page can have several layers at once, and the one with the highest
       * z-index is not necessarily the one holding the close button. Picking
       * just one leaves the close button in the other layers unmarked.
       */
      const overlays = marked.concat(largeFloating);
      // Promo popups use no marker at all, so the dark backdrop is the proof.
      // Without that condition a sticky bottom bar counts as a dialog too, and
      // the agent is told to look for a close button that does not exist.
      const dialogEl = marked[0] ?? (hasBackdrop ? largeFloating[0] ?? null : null);
      const dialog = dialogEl !== null;

      // Error messages on a form. Collected two ways: from semantic markers,
      // and from colour, because many sites only turn the text red without
      // marking anything a machine can read.
      const errSet = new Set<string>();
      const takeErr = (el: Element) => {
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 6) return;
        if (r.bottom < 0 || r.top > vh + 400) return;
        const t = clean((el as HTMLElement).innerText || el.textContent);
        if (t.length < 4 || t.length > 180) return;
        // Discount and price badges often use a class named "error" or get
        // role=alert from a carousel library. They are not error messages.
        if (/^[-+]?\d+([.,]\d+)?\s*%/.test(t)) return;
        if (/^(rp|idr|usd|eur|\$|€|£)\s*[\d.,]+$/i.test(t)) return;
        if (!/\s/.test(t)) return;
        errSet.add(t);
      };

      document
        .querySelectorAll(
          '[role="alert"],[aria-live="assertive"],[aria-invalid="true"],' +
            '[class*="error" i],[class*="invalid" i],[class*="danger" i]',
        )
        .forEach(takeErr);

      /**
       * Red alone is not enough.
       *
       * Shops colour discount badges, struck-out prices and promo labels red.
       * Treating all red text as an error floods the agent with "6% off" and
       * tells it to resubmit a form that does not even exist. So the colour must
       * come with words people actually use when rejecting input.
       */
      const FAILURE_WORDS =
        /gagal|salah|tidak valid|invalid|error|wajib|harus di|minimal|maksimal|sudah (terdaftar|dipakai|digunakan|ada)|tidak (ditemukan|sesuai|cocok|tersedia)|coba lagi|required|belum diisi|kadaluarsa|expired|failed|incorrect|wrong|not valid|must be|must contain|at least|at most|already (registered|taken|in use|exists)|not found|does not match|do not match|doesn't match|don't match|try again|cannot be (empty|blank)|can't be (empty|blank)/i;

      for (const el of Array.from(document.querySelectorAll("p,span,small,div,li"))) {
        if (el.childElementCount > 0) continue;
        const t = clean((el as HTMLElement).innerText || el.textContent);
        if (t.length < 8 || t.length > 180) continue;
        if (!FAILURE_WORDS.test(t)) continue;
        const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(el).color);
        if (!m) continue;
        const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
        if (r > 130 && r > g * 1.7 && r > b * 1.7) takeErr(el);
        if (errSet.size >= 6) break;
      }

      // Captcha. Not to get past it, quite the opposite: once detected, the
      // agent is told so it stops with a clear reason and the user is pointed
      // at pasting a session instead.
      const captcha =
        document.querySelector(
          'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],' +
            'iframe[src*="challenges.cloudflare.com"],iframe[src*="arkoselabs"],' +
            'iframe[src*="funcaptcha"],.g-recaptcha,.h-captcha,.cf-turnstile,' +
            '#px-captcha,[data-sitekey],[data-hcaptcha-sitekey]',
        ) !== null;

      // Sign in through another provider. Its window belongs to another domain
      // and often holds a captcha or two-step verification, so the agent has no
      // way to finish it.
      const thirdParty =
        /\b(google|apple|facebook|github|gitlab|twitter|linkedin|microsoft|sso|saml|okta)\b/i;
      for (const e of elements) {
        if (!e.name) continue;
        if (thirdParty.test(e.name) && /masuk|login|log in|sign|daftar|register|lanjut|continue/i.test(e.name)) {
          e.thirdParty = true;
        }
      }

      // Mark elements that live INSIDE the dialog. Without this marker the
      // agent cannot tell the dialog's content from the page behind it, and
      // tends to pick the close button because it stands out the most.
      if (dialogEl) {
        const inside = marked.length ? marked : largeFloating;
        for (const e of elements) {
          const node = document.querySelector(`[${refAttr}="${e.ref}"]`);
          if (node && inside.some((o) => o.contains(node))) e.inDialog = true;
        }
      }

      return {
        url: location.href,
        hasDialog: dialog,
        hasCaptcha: captcha,
        errors: Array.from(errSet).slice(0, 6),
        title: document.title,
        scrollY: Math.round(window.scrollY),
        scrollHeight: Math.round(document.documentElement.scrollHeight),
        viewport: { w: vw, h: vh },
        elements,
        text,
      };
    },
    { refAttr: REF_ATTR, limit: maxElements },
  ) as Promise<PageSnapshot>;
}

const NOT_TYPED = new Set(["checkbox", "radio", "submit", "button", "reset", "range", "color", "image"]);

/** A field filled by typing: text, password, email, number inputs, textarea. */
export function isFillableField(e: SnapEl): boolean {
  if (e.tag === "textarea") return true;
  return e.tag === "input" && !NOT_TYPED.has((e.type ?? "text").toLowerCase());
}

/** Required fields that are still empty, in page order. */
export function emptyRequiredFields(s: PageSnapshot): SnapEl[] {
  return s.elements.filter((e) => isFillableField(e) && !e.value && e.required && !e.disabled);
}

/**
 * Empty fields named by an error message.
 *
 * "Business name is required" must be linked to the field called "Business
 * Name". The agent often fails to make that link on its own, especially when
 * the field looks filled in the screenshot because of its placeholder.
 */
export function fieldsNamedInErrors(s: PageSnapshot): SnapEl[] {
  const found: SnapEl[] = [];
  const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
  for (const message of s.errors) {
    const p = message.toLowerCase();
    for (const e of s.elements) {
      if (!isFillableField(e) || e.value || found.includes(e)) continue;
      const n = e.name.trim().toLowerCase();
      if (!n) continue;
      const w = words(n);
      if (p.includes(n) || (w.length >= 2 && w.every((x) => p.includes(x)))) found.push(e);
    }
  }
  return found;
}

/** Render the snapshot as compact text for the prompt. */
export function renderSnapshot(s: PageSnapshot): string {
  const lines: string[] = [];
  lines.push(`URL: ${s.url}`);
  lines.push(`Title: ${s.title}`);
  lines.push(
    `Scroll: ${s.scrollY}px of ${s.scrollHeight}px total (viewport ${s.viewport.w}x${s.viewport.h})`,
  );
  if (s.hasDialog) {
    lines.push(
      "A DIALOG IS OPEN. Elements marked [dialog] are inside it.",
    );
    lines.push(
      "If this dialog is part of the goal, COMPLETE its contents all the way.",
    );
    lines.push(
      "Do not press its close/cross/cancel button unless the dialog really is",
    );
    lines.push("just an obstacle unrelated to the goal.");
  }
  if (s.hasCaptcha) {
    lines.push(
      "THERE IS A CAPTCHA ON THIS PAGE. A captcha cannot and must not be solved.",
    );
    lines.push(
      "If the captcha blocks the only way to the goal, use the \"finish\" action",
    );
    lines.push(
      "and write down the reason; do not try to click it or fill it in.",
    );
  }
  lines.push("");
  lines.push("INTERACTIVE ELEMENTS:");
  for (const e of s.elements) {
    const bits = [`[${e.ref}]`, `<${e.tag}${e.type ? ` type=${e.type}` : ""}>`];
    if (e.name) bits.push(`"${e.name}"`);
    if (e.value) bits.push(`(filled: "${e.value}")`);
    else if (isFillableField(e))
      bits.push(
        e.placeholder && e.placeholder !== e.name
          ? `(EMPTY; the grey text "${e.placeholder}" in the image is only an example, NOT filled yet)`
          : "(EMPTY)",
      );
    if (e.inDialog) bits.push("[dialog]");
    if (e.iconBtn)
      bits.push(
        e.inDialog
          ? "(icon button inside the popup, almost certainly its close button)"
          : "(icon button, no text)",
      );
    if (e.thirdParty) bits.push("(SIGN IN THROUGH A THIRD PARTY, cannot be passed, do not click)");
    if (/^(lewati|skip|nanti saja|nanti dulu|lain kali|tutup|batal|abaikan|mungkin nanti|not now|later|maybe later|close|cancel|dismiss|no thanks|no, thanks)$/i.test(e.name.trim()))
      bits.push("(WAY OUT of this dialog)");
    if (e.required) bits.push("(REQUIRED)");
    if (e.disabled) bits.push("(DISABLED, satisfy its condition first)");
    if (e.active) bits.push("(CURRENTLY OPEN: you are already here, pressing it changes nothing)");
    if (!e.inView) bits.push("(off screen, needs scrolling)");
    lines.push("  " + bits.join(" "));
  }
  const empty = emptyRequiredFields(s);
  if (empty.length) {
    lines.push("");
    lines.push(
      "REQUIRED FIELDS STILL EMPTY (the form will be rejected until all of them are filled): " +
        empty.map((e) => `[${e.ref}] "${e.name.slice(0, 40)}"`).join(", "),
    );
  }
  if (s.errors.length) {
    lines.push("");
    lines.push("ERROR MESSAGES CURRENTLY SHOWN:");
    for (const e of s.errors) lines.push(`  ! ${e}`);
    const named = fieldsNamedInErrors(s);
    if (named.length)
      lines.push(`Fields these messages refer to: ${named.map((e) => `[${e.ref}] "${e.name.slice(0, 40)}"`).join(", ")}. Fill those fields.`);
    lines.push(
      "These messages come from the PREVIOUS form submission, and they stay on",
    );
    lines.push(
      "screen until the form is submitted again. They do NOT disappear just because",
    );
    lines.push(
      "you fixed the field, and seeing them again does NOT mean your fix was rejected.",
    );
    lines.push(
      "The order: fix what the messages name, also fill every required field that is",
    );
    lines.push("still EMPTY, and only then PRESS THE SUBMIT BUTTON.");
  }
  lines.push("");
  lines.push("PAGE TEXT:");
  lines.push(s.text);
  return lines.join("\n");
}
