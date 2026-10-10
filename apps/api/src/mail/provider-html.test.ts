import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sanitizeInboundHtml, sanitizeProviderHtml, readableHtmlText } from "./provider-html.ts";

describe("inbound readable formatting and privacy", () => {
  test("normalizes responsive newsletters without restoring sender CSS", () => {
    const raw = readFileSync(new URL("../../../../diagnostics/mobile-email/fixtures/newsletter.html", import.meta.url), "utf8");
    const html = sanitizeInboundHtml(raw)!;
    expect(html).toContain('class="orca-mail-formatted"');
    expect(html).toContain('class="orca-mail-layout"');
    expect(html).toContain("End of community update.");
    expect(html).toContain('[Image blocked: Community workshop banner]');
    expect(html).toContain('href="https://example.invalid/workshop" target="_blank" rel="noopener noreferrer"');
    expect(html).not.toMatch(/<img|<style|@media|width=|height=|padding:|Preview only|pixel.gif/);
  });

  test("does not flatten data tables, mislabelled headers, captions, or spans", () => {
    for (const content of ['<tr><th>Header</th><td>Value</td></tr>', '<caption>Data</caption><tr><td>Value</td></tr>', '<tr><td colspan="2">Value</td></tr>', '<tr><td rowspan="2">Value</td></tr>']) {
      const html = sanitizeInboundHtml(`<table role="presentation">${content}</table>`)!;
      expect(html).not.toContain('orca-mail-layout');
      expect(html).not.toContain('role=');
      expect(html).toContain(content);
    }
    expect(sanitizeInboundHtml('<table><tr><td>Unknown table</td></tr></table>')).toBe('<table><tr><td>Unknown table</td></tr></table>');
  });

  test("nested data tables keep width/header semantics inside layout", () => {
    const html = sanitizeInboundHtml('<table role="none"><tr><td width="640"><table width="1200"><caption>Results</caption><tr><th>Job</th><td style="padding:4px">Passed</td></tr></table></td></tr></table>')!;
    expect(html).toContain('<table class="orca-mail-layout" role="presentation"><tr><td>');
    expect(html).toContain('<table width="1200"><caption>Results</caption><tr><th>Job</th><td style="padding:4px">Passed</td>');
  });

  test("strips sender classes and rejects forged renderer markers", () => {
    const html = sanitizeInboundHtml('<div class="orca-mail-formatted reader-body hidden"><table class="orca-mail-layout" role="grid"><tr><td>Data</td></tr></table></div>')!;
    expect(html).not.toContain('class=');
    expect(html).not.toContain('role=');
  });

  test("all images are inert, alt text is escaped, and no sender executable content survives", () => {
    const html = sanitizeInboundHtml('<img src="https://track.invalid/pixel"><img src="//track.invalid/x" alt="&lt;script&gt;alert(1)&lt;/script&gt;"><img src="cid:logo" alt="Logo"><img src="data:image/svg+xml,evil"><script>alert(1)</script><iframe src="https://track.invalid"></iframe><p onclick="evil()" style="background-image:url(https://track.invalid);position:fixed">Hello</p><a href="javascript:evil()">Bad</a>')!;
    expect(html).not.toMatch(/<img|\bsrc=|<script|<iframe|onclick|background-image|position:|javascript:/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('[Image blocked: Logo]');
    expect(html).toContain('<a target="_blank" rel="noopener noreferrer">Bad</a>');
  });

  test("unrelated ordinary message markup stays readable and outbound images are unchanged", () => {
    const ordinary = '<p>Hello <strong>team</strong>.</p><blockquote>Earlier reply</blockquote>';
    expect(sanitizeInboundHtml(ordinary)).toBe(ordinary);
    expect(sanitizeInboundHtml(null)).toBeNull();
    expect(sanitizeInboundHtml('')).toBeNull();
    expect(sanitizeProviderHtml('<img src="https://example.invalid/photo" />')).toBe('<img src="https://example.invalid/photo" />');
  });

  test("linked images without alt text retain a visible, accessible destination", () => {
    const html = sanitizeInboundHtml('<a href="https://example.invalid/offer"><img src="https://example.invalid/banner"></a>')!;
    expect(html).toContain('href="https://example.invalid/offer"');
    expect(html).toContain('[Image blocked: Open linked image]');
    expect(html).not.toContain('<img');
  });

  test("deep sender markup cannot exhaust the DOM serializer stack or lose text", () => {
    const raw = '<div>'.repeat(20_000) + 'Deep message remains readable' + '</div>'.repeat(20_000);
    expect(sanitizeInboundHtml(raw)).toContain('Deep message remains readable');
    expect(readableHtmlText(raw)).toContain('Deep message remains readable');
  });

  test("hosted native newsletter fixture is the exact production sanitizer output", () => {
    const raw = readFileSync(new URL("../../../../diagnostics/mobile-email/fixtures/newsletter.html", import.meta.url), "utf8");
    const swift = readFileSync(new URL("../../../ios/OrcaTests/SafeHTMLOverflowTests.swift", import.meta.url), "utf8");
    const marked = swift.split('// BEGIN API NEWSLETTER FIXTURE')[1]!.split('// END API NEWSLETTER FIXTURE')[0]!;
    const literal = marked.split('"""')[1]!.replace(/^\n/, '').replace(/\n *$/, '').split('\n').map(line => line.replace(/^ {8}/, '')).join('\n');
    expect(literal).toBe(sanitizeInboundHtml(raw));
  });

  test("structured fallback preserves paragraphs, destinations, table rows, and code whitespace", () => {
    const text = readableHtmlText('<p>First paragraph</p><p><a href="https://example.invalid/details">Details</a></p><table><tr><th>Job</th><th>Status</th></tr><tr><td>Build</td><td>Passed</td></tr></table><pre>    const x = 1;\n\n    return x;</pre>')!;
    expect(text).toContain('First paragraph\nDetails (https://example.invalid/details)\n');
    expect(text).toContain('Job\tStatus\nBuild\tPassed\n');
    expect(text).toContain('    const x = 1;\n\n    return x;');
    expect(readableHtmlText('<script>hidden</script>')).toBeNull();
  });
});
