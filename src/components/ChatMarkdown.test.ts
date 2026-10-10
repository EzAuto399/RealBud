import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown";

const render = (text: string, streaming = false) => renderToStaticMarkup(createElement(ChatMarkdown, { text, streaming }));

describe("readable response structure", () => {
  it("exposes section headings for navigation within the conversation", () => {
    const html = render("# Review result\n\nThe file needs two checks.\n\n## What needs attention\n\nKeep the original reference.\n\n### Next step\n\nCompare the notice.");
    expect(html).toMatch(/<h2[^>]*>Review result<\/h2>/);
    expect(html).toMatch(/<h3[^>]*>What needs attention<\/h3>/);
    expect(html).toMatch(/<h4[^>]*>Next step<\/h4>/);
    expect(html).toContain("Compare the notice.");
  });

  it("preserves table alignment and numbered continuation steps", () => {
    const html = render("| Check | Count |\n| :--- | ---: |\n| Missing dates | 2 |\n\n4. Compare the notice\n5. Review the result");
    expect(html).toContain('role="region" aria-label="Response table"');
    expect(html).toContain('scope="col" style="text-align:right"');
    expect(html).toContain('<td style="text-align:right"');
    expect(html).toContain('<ol start="4"');
  });

  it("keeps streaming code selectable and keyboard-scrollable without interpreting its markup", () => {
    const html = render('```html\n<script>alert("example")</script>\n```', true);
    expect(html).toContain('role="region" aria-label="html code"');
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('Code copied to clipboard');
  });

  it("does not silently trim long replies, lists, or references", () => {
    const text = Array.from({ length: 30 }, (_, index) => `- Reference ${index + 1}: keep every supplied identifier`).join("\n");
    const html = render(text);
    expect(html.match(/<li>/g)).toHaveLength(30);
    expect(html).toContain("Reference 30: keep every supplied identifier");
  });

  it("preserves task-list semantics and keeps raw HTML inert", () => {
    const html = render('- [x] Checked\n- [ ] Needs review\n\n<img src=x onerror="alert(1)">');
    expect(html).toContain("contains-task-list");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('<img src="x"');
  });
});

describe("chart blocks", () => {
  const chart = '```chart\n{"type":"bar","title":"Rent collected","x":["Jul","Aug","Sep"],"series":[{"name":"Collected","values":[1,2,3]}]}\n```';

  it("shows a calm placeholder while streaming, never the raw chart data", () => {
    for (const partial of [chart, chart.slice(0, 40), "```chart\n"]) {
      const html = render(`Collections improved.\n\n${partial}`, true);
      expect(html).toContain('role="status"');
      expect(html).toContain("Drawing chart…");
      expect(html).not.toContain("&quot;type&quot;");
      expect(html).not.toContain("Copy code");
      expect(html).toContain("Collections improved.");
    }
  });

  it("keeps the placeholder footprint until the chart code arrives, with the rest of the reply formatted", () => {
    const html = render(`**Collections improved.**\n\n${chart}\n\n- Chase one tenancy`);
    expect(html).toContain("<strong>Collections improved.</strong>");
    expect(html).toContain("Drawing chart…");
    expect(html).toContain("<li>Chase one tenancy</li>");
    expect(html).not.toContain("&quot;series&quot;");
  });

  it("leaves other code blocks as code", () => {
    const html = render('```json\n{"type":"bar"}\n```');
    expect(html).toContain('aria-label="json code"');
    expect(html).not.toContain("Drawing chart…");
  });
});

