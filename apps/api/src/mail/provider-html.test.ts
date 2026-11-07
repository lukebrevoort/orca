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
    expect(sanitizeProviderHtml('<table role="grid"><tr><td>Data</td></tr></table>')).toBe('<table><tr><td>Data</td></tr></table>');
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
    expect(literal).toBe(sanitizeInboundHtml(raw)!);
  });

  test("only single-content full-width rows receive a non-flattening spacer width hint", () => {
    for (const width of ['width="100%"', 'style="width:100% !important;padding:4px"']) {
      const raw = `<table ${width}><tbody><tr><td><table><tr><td height="400">&nbsp;</td></tr></table></td><td width="650" style="font-size:22px">Content</td><td><div><span> </span><br></div></td></tr></tbody></table>`;
      const html = sanitizeInboundHtml(raw)!;
      expect(html).toContain('class="orca-mail-spacer-table"');
      expect(html.match(/orca-mail-spacer-table/g)).toHaveLength(1);
      expect(html.match(/orca-mail-spacer-cell/g)).toHaveLength(2);
      expect(html).not.toMatch(/orca-mail-layout|orca-mail-formatted|role=/);
      expect(html).toContain('<td width="650" style="font-size:22px">Content</td>');
      expect(html).toContain('<td height="400">&#xa0;</td>');
      expect(sanitizeInboundHtml(html)).toBe(html);
      expect(sanitizeProviderHtml(raw)).not.toContain('orca-mail-spacer-table');
    }
  });

  test("gutter hints cannot be forged and preserve structural spacer dimensions", () => {
    const raw = '<table width="100%"><tr><td class="orca-mail-spacer-cell">Content</td><td width="200" style="padding:3px"><table width="100%"><tr><td height="400">&nbsp;</td></tr></table></td></tr></table>';
    const html = sanitizeInboundHtml(raw)!;
    expect(html).toContain('<td>Content</td>');
    expect(html).toContain('<td width="200" style="padding:3px" class="orca-mail-spacer-cell">');
    expect(html).toContain('<table width="100%"><tr><td height="400">&#xa0;</td></tr></table>');
    expect(html.match(/orca-mail-spacer-cell/g)).toHaveLength(1);
    expect(sanitizeInboundHtml('<table role="grid" width="100%"><tr><td class="orca-mail-spacer-cell"></td><td>Data</td></tr></table>')).not.toContain('orca-mail-spacer');
  });

  test("spacer sizing excludes semantic, multi-content and ambiguous table shapes", () => {
    const rows = [
      '<tr><td></td><td>First</td><td>Second</td></tr>',
      '<tr><td></td><td></td></tr>',
      '<tr><td>Only one cell</td></tr>',
      '<tr><td></td><td>First</td></tr><tr><td></td><td>Second</td></tr>',
      '<tr><th></th><td>Value</td></tr>',
      '<caption>Data</caption><tr><td></td><td>Value</td></tr>',
      '<thead><tr><td></td><td>Value</td></tr></thead>',
      '<tfoot><tr><td></td><td>Value</td></tr></tfoot>',
      '<colgroup><col width="20%"></colgroup><tr><td></td><td>Value</td></tr>',
      '<tr><td colspan="2"></td><td>Value</td></tr>',
      '<tr><td rowspan="1"></td><td>Value</td></tr>',
    ];
    for (const rowsHTML of rows) {
      const raw = `<table width="100%" class="orca-mail-spacer-table">${rowsHTML}</table>`;
      expect(sanitizeInboundHtml(raw)).not.toMatch(/orca-mail-spacer-(?:table|cell)/);
    }
    for (const attrs of ['', 'width="650"', 'style="max-width:100%"', 'width="100%" role="grid"', 'width="100%" role="table"']) {
      expect(sanitizeInboundHtml(`<table ${attrs}><tr><td></td><td>Value</td></tr></table>`)).not.toContain('orca-mail-spacer-table');
    }
    const stats = '<table width="100%"><tr><td>123</td><td>459</td></tr><tr><td>New topics</td><td>New users</td></tr></table>';
    expect(sanitizeInboundHtml(stats)).toBe(stats);
  });

  test("empty-looking content is not a blank spacer, including before image blocking", () => {
    for (const meaningful of [
      '<a href="https://example.invalid"></a>', '<img src="https://example.invalid/photo">',
      '<img src="https://example.invalid/photo" alt="Banner">', '<hr>', '<pre></pre>', '<code></code>',
      '<span style="display:none">Hidden content</span>',
      '<table role="grid"><tr><td></td></tr></table>',
      '<table><caption></caption><tr><td></td></tr></table>',
      '<table><tr><td colspan="2"></td></tr></table>',
    ]) {
      const html = sanitizeInboundHtml(`<table width="100%"><tr><td>${meaningful}</td><td>Content</td></tr></table>`)!;
      expect(html).not.toContain('orca-mail-spacer-table');
      expect(html).toContain('Content');
      expect(html).not.toMatch(/<img|\bsrc=/);
    }
  });

  test("native unmarked digest diagnostic uses exact production sanitizer output", () => {
    const raw = readFileSync(new URL("../../../../diagnostics/mobile-email/fixtures/unmarked-digest.html", import.meta.url), "utf8");
    const html = sanitizeInboundHtml(raw)!;
    const swift = readFileSync(new URL("../../../ios/OrcaTests/SafeHTMLOverflowTests.swift", import.meta.url), "utf8");
    const marked = swift.split('// BEGIN API UNMARKED DIGEST FIXTURE')[1]!.split('// END API UNMARKED DIGEST FIXTURE')[0]!;
    const literal = marked.split('"""')[1]!.replace(/^\n/, '').replace(/\n *$/, '').split('\n').map(line => line.replace(/^ {8}/, '')).join('\n');
    expect(literal).toBe(html);
    expect(html).not.toContain('orca-mail-layout');
    expect(html.match(/orca-mail-spacer-table/g)).toHaveLength(3);
    expect(html.match(/orca-mail-spacer-cell/g)).toHaveLength(5);
    expect(html).not.toContain('<img');
    expect(html).toContain('[Image blocked: Synthetic digest banner]');
    expect(html).toContain('<caption>Synthetic checks</caption>');
    expect(html).toContain('<th>Check</th><th>Status</th>');
    expect(html).toContain('href="https://example.invalid/community"');
  });

  test("structured fallback preserves paragraphs, destinations, table rows, and code whitespace", () => {
    const text = readableHtmlText('<p>First paragraph</p><p><a href="https://example.invalid/details">Details</a></p><table><tr><th>Job</th><th>Status</th></tr><tr><td>Build</td><td>Passed</td></tr></table><pre>    const x = 1;\n\n    return x;</pre>')!;
    expect(text).toContain('First paragraph\nDetails (https://example.invalid/details)\n');
    expect(text).toContain('Job\tStatus\nBuild\tPassed\n');
    expect(text).toContain('    const x = 1;\n\n    return x;');
    expect(readableHtmlText('<script>hidden</script>')).toBeNull();
  });
});
