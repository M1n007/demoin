/** Every number that decides how the video "feels" lives here. */

/** Duration of the cursor's trip to its target before the action runs (ms). */
export const CURSOR_TRAVEL_MS = 520;
/** Duration of the ripple animation on click (ms). */
export const RIPPLE_MS = 480;
/** Pause after an action finishes before moving on (ms). */
export const POST_ACTION_MS = 450;

/** Zoom */
export const ZOOM_IN_MS = 560;
export const ZOOM_OUT_MS = 620;
/** Pause before zooming out once an action is done (ms). */
export const ZOOM_HOLD_MS = 500;
/** If the next action comes sooner than this, don't zoom out, just pan. */
export const ZOOM_MERGE_GAP_MS = 2200;
/**
 * 1.0 = allowed not to move in at all. Forcing a minimum zoom means large
 * targets, say a whole pricing section, always get cropped when what is needed
 * is to see them in full.
 */
export const ZOOM_MIN = 1.0;
/** The recording is 2x, so above this it starts upscaling and looks soft. */
export const ZOOM_MAX = 2.4;
/**
 * Closeness is decided by the element's HEIGHT, not its width: what makes it
 * readable is the height of its letters. Using width makes wide, short input
 * fields always fall back to minimum zoom, and the zoom stops being felt at all.
 */
export const ZOOM_TARGET_HEIGHT = 0.18;
/**
 * The element must FIT entirely after zooming. A value above 1 lets it be
 * cropped, and a zoom that crops the very thing it highlights defeats itself.
 */
export const ZOOM_WIDTH_ALLOWANCE = 0.85;

/** Safety limit for the agent loop. */
export const MAX_STEPS = 26;
/** Hard ceiling no option can raise. */
export const HARD_MAX_STEPS = 60;
/**
 * Tail of the video after the last action (ms). This is the most important
 * part: the viewer needs to see the end result whole, without zoom, before the
 * video ends.
 */
export const OUTRO_MS = 2200;
/** Head of the video before the first action (ms). */
export const INTRO_MS = 900;

export const CURSOR_SIZE = 34;

/**
 * How long a caption must stay up to be read.
 *
 * This is not decoration: without it the caption leaves before the sentence
 * is read, and the viewer loses exactly the context it was meant to give. The
 * number comes from a normal reading speed, about three words per second, with
 * a floor so short sentences don't flicker.
 */
export function readingMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(5200, Math.max(1700, Math.round(words * 330) + 500));
}

/** Step captions. Turned on per run (tour mode or --captions), not globally. */
export const CALLOUT = false;
export const CALLOUT_FADE_MS = 220;
/** stays visible this long after its action is done */
export const CALLOUT_HOLD_MS = 700;
export const CALLOUT_MAX_LINES = 4;
/** Ring around the element being introduced. */
export const RING_PAD = 10;
export const RING_W = 3;
export const CALLOUT_FONT = 25;
export const CALLOUT_LINE = 34;
export const CALLOUT_PAD_X = 22;
export const CALLOUT_PAD_Y = 16;
export const CALLOUT_MAX_W = 620;
/** distance from the element it points at */
export const CALLOUT_GAP = 22;

/** Time map: how much "dead time" may be kept (ms). */
export const KEEP_SETTLE_MS = 800; // waiting for the page to finish loading
/**
 * Pause after the page changes, before the camera moves in again.
 *
 * Changing page means the whole screen changes. If the camera dives straight
 * at the next target, the viewer never gets to see which page they landed on,
 * and every navigation feels like a jump. It must be larger than
 * KEEP_SETTLE_MS so the new page can be read whole, not merely loaded.
 */
export const KEEP_AFTER_NAV_MS = 1300;
// While the agent is thinking nothing changes on screen. This is pure dead
// time, and it used to be long enough to feel like the video hanging before
// every cursor move.
export const KEEP_THINK_MS = 260;

/** Pause before the camera pulls back when a new dialog appears (ms). */
export const REVEAL_HOLD_MS = 260;

/** Spotlight */
export const SPOT_FADE_MS = 320;
export const SPOT_DIM = 0.86;
/** safe margin around the element, following its shape */
export const SPOT_PAD_MIN = 16;
export const SPOT_PAD_MAX = 44;
/** smallest pool of light, so tiny icons still get room */
export const SPOT_MIN_SIZE = 104;
/** corner of the pool of light, capped so big blocks don't turn into ovals */
export const SPOT_CORNER_MAX = 34;
/**
 * Radius of the lit area (px, viewport space). Its UPPER bound matters: if the
 * radius follows the target's width, a 500px wide button gives a lit circle
 * that covers almost the whole screen and the effect can't be read at all. A
 * spotlight has to stay narrow to be a spotlight.
 */
export const SPOT_MIN_RADIUS = 120;
export const SPOT_MAX_RADIUS = 215;
/**
 * A spotlight without the camera moving in feels flat. The spotlight moves in
 * too, but softer than a full zoom so the surrounding context isn't lost.
 */
export const SPOT_ZOOM_FACTOR = 0.6;
export const SPOT_ZOOM_MAX = 1.75;

/** Lightbox */
export const LIGHTBOX_FADE_MS = 340;
export const LIGHTBOX_DIM = 0.62;
export const LIGHTBOX_MAX_W = 0.62; // share of the screen width
export const LIGHTBOX_MAX_H = 0.58;
export const LIGHTBOX_MIN_MAG = 1.5;
export const LIGHTBOX_PAD = 26; // padding around the target (viewport px)

export const FPS = 30;
