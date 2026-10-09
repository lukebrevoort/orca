// Preview text only. Never parse the result as markup or rewrite message bodies.
export function decodeMailPreview(value: string) {
  let text = value;
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
  for (let pass = 0; pass < 2; pass++) text = text.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, name: string) => entities[name]!);
  return text;
}
