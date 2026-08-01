import type {
  FeedbackAttachment,
  FeedbackElementContext,
  FeedbackRuntimeContext,
} from "@feedback-kit/core";

const SRGB_COLOR_PATTERN =
  /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/gi;
const OKLAB_COLOR_PATTERN = /oklab\(\s*([^)]*)\)/gi;
const OKLCH_COLOR_PATTERN = /oklch\(\s*([^)]*)\)/gi;
const UNSUPPORTED_COLOR_PATTERN =
  /(?:color-mix|oklab|oklch|lab|lch|color)\([^)]*\)/gi;

function parseCssNumber(value: string | undefined, percentageScale: number): number | undefined {
  if (!value || value.toLowerCase() === "none") return undefined;
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return undefined;
  return value.trim().endsWith("%") ? (numeric / 100) * percentageScale : numeric;
}

function parseAlpha(value: string | undefined): number {
  return Math.min(1, Math.max(0, parseCssNumber(value, 1) ?? 1));
}

function parseHue(value: string | undefined): number {
  if (!value || value.toLowerCase() === "none") return 0;
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return 0;
  const normalized = value.trim().toLowerCase();
  if (normalized.endsWith("rad")) return numeric;
  if (normalized.endsWith("grad")) return (numeric * Math.PI) / 200;
  if (normalized.endsWith("turn")) return numeric * Math.PI * 2;
  return (numeric * Math.PI) / 180;
}

function encodeSrgb(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped <= 0.0031308
    ? clamped * 12.92
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function oklabToRgb(lightness: number, a: number, b: number, alpha: number): string {
  const l = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const m = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const s = lightness - 0.0894841775 * a - 1.291485548 * b;
  const red = encodeSrgb(4.0767416621 * l ** 3 - 3.3077115913 * m ** 3 + 0.2309699292 * s ** 3);
  const green = encodeSrgb(-1.2684380046 * l ** 3 + 2.6097574011 * m ** 3 - 0.3413193965 * s ** 3);
  const blue = encodeSrgb(-0.0041960863 * l ** 3 - 0.7034186147 * m ** 3 + 1.707614701 * s ** 3);
  const channels = [red, green, blue].map((channel) => Math.round(channel * 255));
  return alpha >= 0.999 ? `rgb(${channels.join(", ")})` : `rgba(${channels.join(", ")}, ${alpha})`;
}

function parseColorArguments(body: string): string[] {
  return body.replaceAll(",", " ").split(/\s*\/\s*|\s+/).filter(Boolean);
}

function convertOklab(_match: string, body: string): string {
  const [lightnessToken, aToken, bToken, alphaToken] = parseColorArguments(body);
  const lightness = parseCssNumber(lightnessToken, 1);
  const a = parseCssNumber(aToken, 0.4);
  const b = parseCssNumber(bToken, 0.4);
  if (lightness === undefined || a === undefined || b === undefined) return "transparent";
  return oklabToRgb(lightness, a, b, parseAlpha(alphaToken));
}

function convertOklch(_match: string, body: string): string {
  const [lightnessToken, chromaToken, hueToken, alphaToken] = parseColorArguments(body);
  const lightness = parseCssNumber(lightnessToken, 1);
  const chroma = parseCssNumber(chromaToken, 0.4);
  if (lightness === undefined || chroma === undefined) return "transparent";
  const hue = parseHue(hueToken);
  return oklabToRgb(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue), parseAlpha(alphaToken));
}

function toLegacyColors(value: string): string {
  const normalized = value.replace(
    SRGB_COLOR_PATTERN,
    (_match, red: string, green: string, blue: string, alpha?: string) => {
      const channels = [red, green, blue].map((channel) =>
        Math.round(Number(channel) * 255),
      );
      return alpha === undefined
        ? `rgb(${channels.join(", ")})`
        : `rgba(${channels.join(", ")}, ${alpha})`;
    },
  ).replace(OKLAB_COLOR_PATTERN, convertOklab).replace(OKLCH_COLOR_PATTERN, convertOklch);

  return normalized.replace(UNSUPPORTED_COLOR_PATTERN, "transparent");
}

function copyComputedStyles(
  originalElements: HTMLElement[],
  clonedElements: HTMLElement[],
): void {
  originalElements.forEach((original, index) => {
    const cloned = clonedElements[index];
    if (!cloned) return;

    const computed = window.getComputedStyle(original);
    cloned.removeAttribute("style");
    for (let propertyIndex = 0; propertyIndex < computed.length; propertyIndex += 1) {
      const property = computed.item(propertyIndex);
      cloned.style.setProperty(
        property,
        toLegacyColors(computed.getPropertyValue(property)),
        computed.getPropertyPriority(property),
      );
    }
  });
}

export function collectRuntimeContext(): FeedbackRuntimeContext {
  return {
    url: window.location.href,
    route: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    title: document.title,
    userAgent: navigator.userAgent,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      pixelRatio: window.devicePixelRatio,
    },
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    capturedAt: new Date().toISOString(),
  };
}

export async function capturePageScreenshot(
  target: HTMLElement = document.body,
): Promise<FeedbackAttachment> {
  const { default: html2canvas } = await import("html2canvas");
  const canvas = await html2canvas(target, {
    backgroundColor: null,
    logging: false,
    onclone: (clonedDocument, clonedTarget) => {
      // Orca uses color-mix() extensively, which html2canvas currently
      // resolves to the unsupported color() syntax. Keep the live page
      // untouched, remove styles from the temporary clone, and inline the
      // computed styles using legacy-safe color values.
      clonedDocument.head.replaceChildren();
      const originalElements = [target, ...Array.from(target.querySelectorAll("*"))]
        .filter((element) => element.nodeType === 1) as HTMLElement[];
      const clonedElements = [
        clonedTarget,
        ...Array.from(clonedTarget.querySelectorAll("*")),
      ].filter((element) => element.nodeType === 1) as HTMLElement[];
      copyComputedStyles(originalElements, clonedElements);
    },
    useCORS: true,
    scale: Math.min(window.devicePixelRatio, 2),
    ignoreElements: (element) =>
      Boolean(element.closest("[data-feedback-kit-root]")),
  });

  return {
    id: crypto.randomUUID(),
    name: `feedback-${new Date().toISOString().replaceAll(":", "-")}.png`,
    mimeType: "image/png",
    dataUrl: canvas.toDataURL("image/png", 0.92),
    source: "automatic-screenshot",
  };
}

export function createSelector(element: Element): string {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current !== document.body && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    const testId = current.getAttribute("data-testid");
    if (testId) {
      parts.unshift(`[data-testid="${CSS.escape(testId)}"]`);
      break;
    }

    const parent: Element | null = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (child) => child.tagName === current?.tagName,
      );
      if (siblings.length > 1) {
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
      }
    }
    parts.unshift(part);
    current = parent;
  }

  return parts.join(" > ");
}

export function describeElement(element: Element): FeedbackElementContext {
  const rect = element.getBoundingClientRect();
  const text = element.textContent?.replace(/\s+/g, " ").trim().slice(0, 240);
  const html = element.outerHTML.replace(/\s+/g, " ").slice(0, 1_000);

  return {
    selector: createSelector(element),
    tagName: element.tagName.toLowerCase(),
    ...(text ? { text } : {}),
    ...(element.getAttribute("aria-label")
      ? { ariaLabel: element.getAttribute("aria-label") ?? undefined }
      : {}),
    ...(element.getAttribute("role")
      ? { role: element.getAttribute("role") ?? undefined }
      : {}),
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    html,
  };
}

export async function fileToAttachment(
  file: File,
  source: FeedbackAttachment["source"],
): Promise<FeedbackAttachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file."));
    reader.readAsDataURL(file);
  });

  return {
    id: crypto.randomUUID(),
    name: file.name || `pasted-image-${Date.now()}.png`,
    mimeType: file.type || "application/octet-stream",
    dataUrl,
    source,
  };
}
