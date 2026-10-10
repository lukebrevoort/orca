import sanitizeHtml from "sanitize-html";
import { parseDocument, DomUtils } from "htmlparser2";

export const providerHtmlPolicy: sanitizeHtml.IOptions = {
  allowedTags: [
    "a", "abbr", "address", "article", "aside", "b", "blockquote", "br", "caption",
    "cite", "code", "col", "colgroup", "dd", "del", "details", "div", "dl", "dt",
    "em", "fieldset", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4",
    "h5", "h6", "header", "hr", "i", "img", "ins", "legend", "li", "main", "mark",
    "nav", "ol", "p", "pre", "s", "section", "small", "span", "strong", "sub",
    "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr",
    "u", "ul",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel", "name"],
    img: ["src", "alt", "width", "height", "title"],
    td: ["colspan", "rowspan", "align", "valign", "width", "height", "style"],
    th: ["colspan", "rowspan", "align", "valign", "width", "height", "style"],
    table: ["border", "cellpadding", "cellspacing", "width", "align", "style"],
    col: ["width", "style"],
    colgroup: ["width", "span", "style"],
    tr: ["align", "valign", "style"],
    div: ["align", "style", "data-email-preheader"],
    p: ["align", "style"],
    span: ["style"],
    "*": ["class", "style"],
  },
  allowedSchemes: ["http", "https", "mailto", "cid"],
  disallowedTagsMode: "discard",
  exclusiveFilter: (frame) => {
    if (frame.tag !== "div") return false;
    if (frame.attribs["data-email-preheader"] === "true") return true;
    const style = frame.attribs.style ?? "";
    const hasHiddenStyle = /(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)/i.test(style);
    const hasZeroSize = /(?:height|max-height|width|max-width)\s*:\s*0(?:px)?/i.test(style);
    return hasHiddenStyle && hasZeroSize;
  },
  allowedStyles: {
    "*": {
      "margin": [/.*/],
      "margin-top": [/.*/],
      "margin-right": [/.*/],
      "margin-bottom": [/.*/],
      "margin-left": [/.*/],
      "padding": [/.*/],
      "padding-top": [/.*/],
      "padding-right": [/.*/],
      "padding-bottom": [/.*/],
      "padding-left": [/.*/],
      "width": [/.*/],
      "height": [/.*/],
      "max-width": [/.*/],
      "max-height": [/.*/],
      "min-width": [/.*/],
      "min-height": [/.*/],
      "text-align": [/.*/],
      "visibility": [/.*/],
      "opacity": [/.*/],
      "overflow": [/.*/],
      "overflow-x": [/.*/],
      "overflow-y": [/.*/],
      "vertical-align": [/.*/],
      "font-family": [/.*/],
      "font-size": [/.*/],
      "font-weight": [/.*/],
      "font-style": [/.*/],
      "line-height": [/.*/],
      "letter-spacing": [/.*/],
      "text-decoration": [/.*/],
      "text-transform": [/.*/],
      "border": [/.*/],
      "border-top": [/.*/],
      "border-right": [/.*/],
      "border-bottom": [/.*/],
      "border-left": [/.*/],
      "border-radius": [/.*/],
      "border-collapse": [/.*/],
      "border-spacing": [/.*/],
      "display": [/.*/],
      "float": [/.*/],
      "white-space": [/.*/],
      "word-break": [/.*/],
      "overflow-wrap": [/.*/],
      "table-layout": [/.*/],
    },
  },
  transformTags: {
    a: (_tagName, attributes) => ({
      tagName: "a",
      attribs: { ...attributes, target: "_blank", rel: "noopener noreferrer" },
    }),
  },
};

export function sanitizeProviderHtml(value: string | null) {
  return value === null ? null : sanitizeHtml(value, providerHtmlPolicy) || null;
}

type Node = ReturnType<typeof parseDocument>["children"][number];
type Tag = Extract<Node, { type: "tag" | "script" | "style" }>;
const isTag = (node: Node): node is Tag => "attribs" in node;
const escapeText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// Inbound presentation only. Outbound drafts retain the original policy above.
// Sender classes cannot invoke application CSS or forge our layout markers.
const inboundPolicy: sanitizeHtml.IOptions = {
  ...providerHtmlPolicy,
  // Bound subsequent DOM traversal/serialization without dropping deep text.
  nestingLimit: 128,
  allowedAttributes: {
    ...providerHtmlPolicy.allowedAttributes,
    "*": ["style"],
    table: [...((providerHtmlPolicy.allowedAttributes || {}).table as string[]), "role"],
  },
};

function tableParts(table: Tag): Tag[] {
  const parts: Tag[] = [];
  const visit = (node: Node) => {
    if (!isTag(node) || node.name === "table") return;
    parts.push(node);
    node.children.forEach(visit);
  };
  table.children.forEach(visit);
  return parts;
}

/** A role is a hint, not permission to flatten semantic data. Unknown tables
 * keep their structure. Nested tables are classified independently. */
function isLayoutTable(table: Tag) {
  if (!["presentation", "none"].includes(table.attribs.role?.toLowerCase() ?? "")) return false;
  const parts = tableParts(table);
  return parts.some(node => node.name === "td") && !parts.some(node =>
    ["th", "caption", "thead", "tfoot"].includes(node.name)
    || "rowspan" in node.attribs || "colspan" in node.attribs);
}

export function sanitizeInboundHtml(value: string | null): string | null {
  if (value === null) return null;
  const safe = sanitizeHtml(value, inboundPolicy);
  if (!safe) return null;
  const document = parseDocument(safe);
  let hasLayout = false;
  const visit = (node: Node, inLayout: boolean) => {
    if (!isTag(node)) return;
    if (node.name === "img") {
      // No resource URL reaches either client, including a hidden formatted DOM.
      // CID resolution needs a separate attachment-backed privacy contract.
      let parent = node.parent;
      let linked = false;
      while (parent) {
        if ("attribs" in parent && parent.name === "a" && parent.attribs.href) { linked = true; break; }
        parent = parent.parent;
      }
      const alt = node.attribs.alt?.trim() || (linked ? "Open linked image" : "");
      const replacement = parseDocument(alt ? `<span class="orca-mail-image-note">[Image blocked: ${escapeText(alt)}]</span>` : "").children[0];
      if (replacement) DomUtils.replaceElement(node, replacement);
      else DomUtils.removeElement(node);
      return;
    }
    if (node.name === "table") {
      inLayout = isLayoutTable(node);
      delete node.attribs.role;
      if (inLayout) {
        hasLayout = true;
        node.attribs.class = "orca-mail-layout";
        node.attribs.role = "presentation";
      }
    }
    if (inLayout && !["pre", "code"].includes(node.name)) {
      // Normalize the layout as a unit, not a hybrid of stripped responsive CSS
      // and retained desktop dimensions. Preserve content, links and semantics.
      for (const attribute of ["style", "width", "height", "cellpadding", "cellspacing", "border", "align", "valign"]) delete node.attribs[attribute];
    }
    for (const child of [...node.children]) visit(child, inLayout);
    if (inLayout && ["td", "tr"].includes(node.name)
      && !DomUtils.textContent(node).trim()
      && !DomUtils.findOne(child => ["table", "pre", "a", "hr"].includes(child.name), node.children)) {
      DomUtils.removeElement(node);
    }
  };
  for (const child of [...document.children]) visit(child, false);
  const html = DomUtils.getInnerHTML(document);
  return html ? hasLayout ? `<div class="orca-mail-formatted">${html}</div>` : html : null;
}

/** Used only when the provider has no MIME text/plain alternative. Keep block
 * boundaries and destinations; never replace stored/reply source content. */
export function readableHtmlText(value: string | null): string | null {
  const safe = value === null ? null : sanitizeHtml(value, { ...providerHtmlPolicy, nestingLimit: 128 });
  if (!safe) return null;
  const document = parseDocument(safe);
  const blocks = new Set(["address", "article", "blockquote", "div", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "p", "section", "table", "tr"]);
  let output = "";
  const newline = () => { if (output && !output.endsWith("\n")) output += "\n"; };
  const visit = (node: Node) => {
    if (node.type === "text") { output += node.data.replace(/\s+/g, " "); return; }
    if (!isTag(node)) return;
    if (node.name === "pre") { newline(); output += DomUtils.textContent(node); newline(); return; }
    if (node.name === "br") { output += "\n"; return; }
    if (blocks.has(node.name)) newline();
    if (node.name === "li") output += "• ";
    node.children.forEach(visit);
    if (node.name === "a" && node.attribs.href && DomUtils.textContent(node).trim() !== node.attribs.href) output += ` (${node.attribs.href})`;
    if (["td", "th"].includes(node.name)) {
      let next = node.next;
      while (next?.type === "text" && !next.data.trim()) next = next.next;
      if (next && isTag(next) && ["td", "th"].includes(next.name) && !output.endsWith("\n")) output += "\t";
    }
    if (blocks.has(node.name)) newline();
  };
  document.children.forEach(visit);
  // Do not trim lines or normalize the completed string: pre indentation and
  // explicit blank lines are part of the message.
  return output.trim() ? output : null;
}
