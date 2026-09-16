import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionNotice } from "./ActionNotice";
import { ApprovalScope } from "./ApprovalScope";
import { WorkContextCard } from "./WorkContextCard";
import { isWorkspaceSetupTarget } from "@/lib/workspace-setup";

describe("workspace interaction contracts", () => {
  it("offers dismissal without inventing a retry for an unknown action", () => {
    const html = renderToStaticMarkup(createElement(ActionNotice, { message: "The action was not confirmed.", onDismiss: () => {} }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Dismiss message");
    expect(html).not.toContain("Try again");
  });
  it("adds retry only when the owner supplies recovery", () => {
    expect(renderToStaticMarkup(createElement(ActionNotice, { message: "Could not load results", onRetry: () => {} }))).toContain("Try again");
  });
  it("distinguishes plan approval from permission and completion of an action", () => {
    expect(renderToStaticMarkup(createElement(ApprovalScope, { kind: "plan" }))).toContain("require their own review");
    expect(renderToStaticMarkup(createElement(ApprovalScope, { kind: "action" }))).toContain("does not mean the action has finished");
  });
  it("renders reference text as text, not instructions or markup", () => {
    const html = renderToStaticMarkup(createElement(WorkContextCard, { title: "<script>test</script>", detail: "Old result", status: "Reference attached" }));
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('aria-label="Work context"');
  });
  it("accepts only known setup targets", () => {
    expect(isWorkspaceSetupTarget("phone")).toBe(true);
    expect(isWorkspaceSetupTarget("https://example.com")).toBe(false);
    expect(isWorkspaceSetupTarget({ target: "bud" })).toBe(false);
  });
});
