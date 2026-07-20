export type EmbedTheme = "light" | "dark" | "system";

export type EmbedOptions = {
  embedded: boolean;
  theme?: EmbedTheme;
  /** Brand colour as #rrggbb, adopted as the app's `--primary`. */
  primary?: string;
  /** Corner radius as a CSS length, adopted as the app's `--radius`. */
  radius?: string;
  /** Button corner radius, for brands whose buttons are rounder than their panels. */
  buttonRadius?: string;
  /** Google Fonts family name, loaded into the frame and applied. */
  font?: string;
};

const EMBED_THEMES: EmbedTheme[] = ["light", "dark", "system"];

// Host-supplied values reach us through a URL that anyone can craft, and they
// end up in a stylesheet href and CSS declarations. Each is matched against the
// narrowest pattern that still expresses the setting, so nothing else can ride
// along; a value that does not match is dropped rather than sanitised.
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
const CSS_LENGTH = /^(?:0|\d{1,2}(?:\.\d{1,3})?)(?:rem|em|px)$/;
const FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ]{0,49}$/;

export const HEIGHT_MESSAGE_TYPE = "someday:height";

type ParamBag = URLSearchParams | Record<string, string | undefined>;

function readParam(params: ParamBag, key: string): string | undefined {
  return params instanceof URLSearchParams
    ? params.get(key) ?? undefined
    : params[key];
}

function match(value: string | undefined, pattern: RegExp): string | undefined {
  return value && pattern.test(value) ? value : undefined;
}

export function parseEmbedOptions(params: ParamBag): EmbedOptions {
  const embed = readParam(params, "embed");
  const theme = readParam(params, "theme");
  return {
    embedded: embed === "1" || embed === "true",
    theme: EMBED_THEMES.includes(theme as EmbedTheme)
      ? (theme as EmbedTheme)
      : undefined,
    primary: match(readParam(params, "primary"), HEX_COLOUR),
    radius: match(readParam(params, "radius"), CSS_LENGTH),
    buttonRadius: match(readParam(params, "button-radius"), CSS_LENGTH),
    font: match(readParam(params, "font"), FONT_FAMILY),
  };
}

export function applyEmbedClass(embedded: boolean) {
  document.documentElement.classList.toggle("embedded", embedded);
}

function channels(hex: string): [number, number, number] {
  const int = parseInt(hex.slice(1), 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

/** Converts #rrggbb to the bare `H S% L%` triplet the theme's tokens hold. */
function hexToHslTriplet(hex: string): string {
  const [r, g, b] = channels(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  const lightness = (max + min) / 2;

  let hue = 0;
  let saturation = 0;
  if (span !== 0) {
    saturation =
      lightness > 0.5 ? span / (2 - max - min) : span / (max + min);
    if (max === r) hue = (g - b) / span + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / span + 2;
    else hue = (r - g) / span + 4;
    hue *= 60;
  }

  const round = (n: number) => Math.round(n * 10) / 10;
  return `${round(hue)} ${round(saturation * 100)}% ${round(lightness * 100)}%`;
}

/**
 * Picks the token for text sitting on `hex`. 0.179 is where WCAG relative
 * luminance stops favouring white text and starts favouring black: below it,
 * white contrasts better; above it, black does.
 */
function readableOn(hex: string): string {
  const [r, g, b] = channels(hex)
    .map((c) => c / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.179 ? "240 10% 3.9%" : "0 0% 98%";
}

function loadWebFont(family: string) {
  if (document.querySelector("link[data-embed-font]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  // The family is already constrained to letters, digits and spaces, so it
  // cannot break out of the query string.
  const name = encodeURIComponent(family).replace(/%20/g, "+");
  link.href = `https://fonts.googleapis.com/css2?family=${name}:wght@400;500;600;700&display=swap`;
  link.setAttribute("data-embed-font", "");
  document.head.appendChild(link);
}

/**
 * Adopts the host's brand tokens. The app's own components are already drawn
 * from these variables, so setting them here is enough to restyle buttons,
 * focus rings and the selected date together — the host never sends CSS.
 */
export function applyHostStyling(options: EmbedOptions) {
  const root = document.documentElement;

  if (options.primary) {
    // Set inline so these outrank both the light and dark token blocks: the
    // host's brand is its brand in either theme.
    root.style.setProperty("--primary", hexToHslTriplet(options.primary));
    root.style.setProperty("--primary-foreground", readableOn(options.primary));
    root.style.setProperty("--ring", hexToHslTriplet(options.primary));
  }

  if (options.radius) {
    root.style.setProperty("--radius", options.radius);
  }

  if (options.buttonRadius) {
    root.style.setProperty("--button-radius", options.buttonRadius);
  }

  if (options.font) {
    loadWebFont(options.font);
    root.style.fontFamily = `"${options.font}", system-ui, sans-serif`;
  }
}

/**
 * Publishes the app's content height to the embedding page so it can size the
 * iframe to fit. A cross-origin host cannot measure us itself — reading our
 * document from the outside throws — so this message is the only channel.
 *
 * Requires the `embedded` class to be applied first: without it the body's
 * `min-height: 100vh` pins content to the frame's current height, so every
 * measurement would just echo back the height the host already set.
 */
export function reportHeightToHost(): () => void {
  const host = window.top;
  if (!host) return () => {};

  let lastSent = -1;
  const post = () => {
    // offsetHeight, not scrollHeight: scrollHeight never reports less than the
    // viewport, so it would echo back whatever height the host just set and the
    // frame could grow but never shrink.
    const height = Math.ceil(document.documentElement.offsetHeight);
    // A 1px threshold keeps sub-pixel layout jitter from ping-ponging with the
    // host's height assignment.
    if (Math.abs(height - lastSent) <= 1) return;
    lastSent = height;
    // The payload is a height and nothing else, so it is safe for any embedder
    // to receive; the host URL is not knowable from inside Apps Script's frames.
    host.postMessage({ type: HEIGHT_MESSAGE_TYPE, height }, "*");
  };

  const observer = new ResizeObserver(post);
  observer.observe(document.documentElement);
  window.addEventListener("resize", post);
  // A webfont swapping in reflows the text after first paint; ResizeObserver
  // catches the height change, but this covers a swap that leaves the box the
  // same size on this frame and settles a pixel later.
  document.fonts?.ready.then(post).catch(() => {});
  post();

  return () => {
    observer.disconnect();
    window.removeEventListener("resize", post);
  };
}
