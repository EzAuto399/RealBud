import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it("keeps setup redirects and internal runtime language out of primary work surfaces", () => {
  const files = ["RoutinesPage.tsx", "WorkdayPulse.tsx", "desk/JobRunFeed.tsx", "schedule/JobWorkspace.tsx", "desk/MorningBrief.tsx", "desk/DeskBud.tsx", "WorkContextCard.tsx", "ApprovalScope.tsx", "AskWorkspaceSheet.tsx", "../../server/routines.ts"];
  const forbidden = /You\s*(?:→|>)|mint (?:a )?browser session|RealBud clock|on the clock|The clock presses|mint.*session|\bMCP\b|\bHermes\b|\bbroker\b/i;
  const failures: string[] = [];
  for (const file of files) {
    const path = fileURLToPath(new URL(`../components/${file}`, import.meta.url));
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      // Comments and identifiers are implementation details, not interface copy.
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        if (forbidden.test(node.text)) failures.push(`${file}: ${node.text.trim()}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(failures).toEqual([]);
});
