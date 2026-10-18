import { expect, spyOn, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createSession } from "../../auth/session-store.ts";
import { createDatabaseClient } from "../../db/client.ts";
import * as schema from "../../db/schema.ts";
import { createApp } from "../../index.ts";
import * as providerHtml from "../provider-html.ts";
import { hasLoadableImages } from "./render.ts";
import { remoteImageURL } from "./remote.ts";

const { parseDocument, DomUtils } = createRequire(import.meta.url)("htmlparser2") as typeof import("htmlparser2");
const src = "https://images.example.org/banner.png";
// Frozen pre-optimization algorithm from e9f928258479aa7b46f7489c6e3e100c254a064f.
// Intentionally retain full provider sanitization/parsing, with no raw-text hint.
function referenceEligibility(html: string | null) {
  const document = parseDocument(providerHtml.sanitizeProviderHtml(html) ?? "");
  return DomUtils.findAll(n => n.type === "tag" && n.name === "img", document.children).some(image => {
    if (image.type !== "tag") return false;
    for (const key of ["width", "height"]) {
      const value = image.attribs[key];
      if (value && /^\d+(?:px)?$/.test(value) && parseInt(value) <= 2) return false;
    }
    return Boolean(remoteImageURL(image.attribs.src ?? ""));
  });
}

test("eligibility retains positive images and rejects encoded markup, blocked URLs and declared trackers", () => {
  const cases: Array<[string | null, boolean]> = [
    [null, false], ["", false], ["<p>No image</p>", false],
    [`<img src="${src}">`, true], [`<IMG SRC="${src}">`, true],
    [`<iMg\nsRc='https&#58;//images.example.org/banner.png'>`, true],
    [`<img src='&#104;ttps://images.example.org/banner.png'>`, true],
    [`<img src="${src}" width="3" height="3">`, true],
    [`<img src="${src}" width="2px">`, false],
    [`<img src="${src}" height="1">`, false],
    [`<img src="${src}" width="1"><img src="${src}">`, true],
    [`<!-- <img src="${src}"> -->`, false],
    [`<script><img src="${src}"></script>`, false],
    [`&lt;img src="${src}"&gt;`, false],
    [`&#60;img src="${src}"&#62;`, false],
    [`<im&#103; src="${src}">`, false],
    [`<image src="${src}">`, true], [`<IMAGE SRC="${src}">`, true],
    [`<div data-email-preheader="true"><img src="${src}"></div>`, false],
    ...["http://images.example.org/a", "javascript:alert(1)", "data:image/png;base64,AAAA", "cid:logo", "//images.example.org/a", "https://127.0.0.1/a", "https://user:pass@images.example.org/a", "https://images.example.org:8443/a", "https://images.example.org/a#fragment"].map(url => [`<img src="${url}">`, false] as [string, boolean]),
  ];
  for (const [html, expected] of cases) {
    expect(referenceEligibility(html)).toBe(expected);
    expect(hasLoadableImages(html)).toBe(expected);
  }
});

test("malformed, entity, raw-text and nested HTML agrees with the pre-optimization policy", () => {
  const tags = ["img", "IMG", "iMg", "image", "im&#103;", "&#105;mg", "im\0g", "i\nmg", " img", "\timg", "/img", "imgx", "img/", "img\0", "img\f", "img\r", "İMG"];
  const attrs = [` src="${src}"`, ` src=${src}`, ` src='https&colon;//images.example.org/a'`, ` src='javascript:evil()'`, ` src='${src}' width='1'`, ` src='${src}' height='3'`, ` src='${src}' src='http://blocked.example.org/a'`];
  const wrap = [
    (s: string) => s, (s: string) => `<!--${s}-->`, (s: string) => `<script>${s}</script>`,
    (s: string) => `<textarea>${s}</textarea>`, (s: string) => `<style>${s}</style>`,
    (s: string) => `<svg><foreignObject>${s}</foreignObject></svg>`,
    (s: string) => `<div style="display:none;height:0">${s}</div>`,
    (s: string) => `<table role="presentation"><tr><td>${s}</td></tr></table>`,
  ];
  for (const tag of tags) for (const attr of attrs) for (const wrapper of wrap) {
    const html = wrapper(`<${tag}${attr}>`);
    expect(hasLoadableImages(html)).toBe(referenceEligibility(html));
  }
  for (const html of [
    `<<img src="${src}">`, `<img src="${src}"`, `<img/src="${src}">`,
    `<div title='<img src="${src}">'>text</div>`, `<![CDATA[<img src="${src}">]]>`,
    `<im<!-- comment -->g src="${src}">`, `<div>${"<div>".repeat(140)}<img src="${src}">`,
    `${"<p>ordinary text</p>".repeat(6000)}<ImG src="${src}">`,
    `${"&lt;im&#103;&gt;".repeat(8000)}`, `<img src="${"a".repeat(2050)}">`,
  ]) expect(hasLoadableImages(html)).toBe(referenceEligibility(html));
});

test("image-free eligibility avoids provider sanitizer work while possible tags still use its policy", () => {
  const sanitize = providerHtml.sanitizeProviderHtml;
  let calls = 0;
  const spy = spyOn(providerHtml, "sanitizeProviderHtml").mockImplementation(html => { calls++; return sanitize(html); });
  try {
    for (const html of [null, "", "<p>ordinary text</p>".repeat(6000), "&lt;im&#103;&gt;"]) expect(hasLoadableImages(html)).toBe(false);
    expect(calls).toBe(0);
    expect(hasLoadableImages(`<!-- <IMG src="${src}"> -->`)).toBe(false);
    expect(calls).toBe(1);
    expect(hasLoadableImages(`<IMG src="${src}">`)).toBe(true);
    expect(calls).toBe(2);
  } finally { spy.mockRestore(); }
});

test("long-thread GET retains image availability, inert bodies and account isolation without consent or downloads", async () => {
  const previousKey = process.env.TOKEN_ENCRYPTION_KEY;
  const previousSecret = process.env.SESSION_SECRET;
  const directory = mkdtempSync(join(tmpdir(), "orca-image-eligibility-"));
  const path = join(directory, "fixture.sqlite");
  const { db, sqlite } = createDatabaseClient(path);
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.SESSION_SECRET = "synthetic-image-eligibility-regression-secret";
  try {
    migrate(db, { migrationsFolder: resolve(import.meta.dir, "../../../drizzle") });
    db.insert(schema.users).values([{ id: "owner", email: "owner@example.com" }, { id: "other", email: "other@example.com" }]).run();
    db.insert(schema.oauthAccounts).values([
      { id: "a", userId: "owner", provider: "gmail", providerId: "a", providerEmail: "owner@example.com" },
      { id: "b", userId: "other", provider: "gmail", providerId: "b", providerEmail: "other@example.com" },
    ]).run();
    db.insert(schema.threads).values([{ id: "thread", accountId: "a", providerThreadId: "same", messageCount: 50 }, { id: "private", accountId: "b", providerThreadId: "same", messageCount: 1 }]).run();
    const bodies = ["<p>Ordinary &amp; safe</p>".repeat(180), `<ImG src="${src}" alt="Banner"><script>evil()</script>`, `<img src="${src}" width="1">`, "&lt;img src='https://images.example.org/a'&gt;"];
    const messages = Array.from({ length: 50 }, (_, index) => ({ id: `m-${index}`, accountId: "a", threadId: "thread", providerMessageId: `m-${index}`, fromAddress: "sender@example.com", bodyText: "Synthetic", bodyHtml: bodies[index % bodies.length]!, receivedAt: new Date(1000 + index), createdAt: new Date(1000 + index) }));
    db.insert(schema.emails).values(messages).run();
    db.insert(schema.emails).values({ id: "secret", accountId: "b", threadId: "private", providerMessageId: "m-0", bodyHtml: `<img src="${src}" alt="PRIVATE">` }).run();
    const session = await createSession(db, "owner");
    const headers = { cookie: `orca_session=${session.token}` };
    let downloads = 0;
    const app = createApp({ dbFactory: () => createDatabaseClient(path), downloadMessageImage: async () => { downloads++; throw Error("No network in fixture"); } });
    let first = "";
    for (let read = 0; read < 2; read++) {
      const response = await app.request("/v1/threads/thread?accountId=a", { headers });
      expect(response.status).toBe(200);
      const text = await response.text();
      if (read) expect(text).toBe(first); else first = text;
      const detail = JSON.parse(text);
      expect(detail.messages).toHaveLength(50);
      for (const [index, message] of detail.messages.entries()) {
        expect(message.accountId).toBe("a");
        expect(message.imageLoadAvailable).toBe(index % 4 === 1);
        expect(message.bodyHtml).toBe(providerHtml.sanitizeInboundHtml(messages[index]!.bodyHtml));
        expect(message.bodyHtml ?? "").not.toMatch(/<img|<script|PRIVATE/);
      }
    }
    for (const url of ["/v1/threads/private?accountId=a", "/v1/threads/private?accountId=b"]) expect((await app.request(url, { headers })).status).toBe(404);
    expect((await app.request("/v1/threads/thread?accountId=a")).status).toBe(401);
    expect(downloads).toBe(0);
  } finally {
    sqlite.close(); rmSync(directory, { recursive: true, force: true });
    if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = previousSecret;
  }
});
