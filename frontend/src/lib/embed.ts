export type EmbedTheme = "light" | "dark" | "system";

export type EmbedOptions = {
  embedded: boolean;
  theme?: EmbedTheme;
};

const EMBED_THEMES: EmbedTheme[] = ["light", "dark", "system"];

export const HEIGHT_MESSAGE_TYPE = "someday:height";

type ParamBag = URLSearchParams | Record<string, string | undefined>;

function readParam(params: ParamBag, key: string): string | undefined {
  return params instanceof URLSearchParams
    ? params.get(key) ?? undefined
    : params[key];
}

export function parseEmbedOptions(params: ParamBag): EmbedOptions {
  const embed = readParam(params, "embed");
  const theme = readParam(params, "theme");
  return {
    embedded: embed === "1" || embed === "true",
    theme: EMBED_THEMES.includes(theme as EmbedTheme)
      ? (theme as EmbedTheme)
      : undefined,
  };
}

export function applyEmbedClass(embedded: boolean) {
  document.documentElement.classList.toggle("embedded", embedded);
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
  post();

  return () => {
    observer.disconnect();
    window.removeEventListener("resize", post);
  };
}
