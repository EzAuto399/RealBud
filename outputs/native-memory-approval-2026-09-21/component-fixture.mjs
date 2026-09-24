// <stdin>
import { createElement, Fragment as Fragment2 } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// src/components/ApprovalScope.tsx
import { jsx } from "react/jsx-runtime";
function ApprovalScope({ kind }) {
  return /* @__PURE__ */ jsx("p", { className: "mt-2 text-[12px] leading-relaxed text-ink-muted", children: kind === "plan" ? "Approving saves these steps and any selected schedule. Sending, payments and record changes still require their own review." : "Review the action and its details. Allow once approves this request only; it does not mean the action has finished." });
}

// src/components/PendingApproval.tsx
import { memo } from "react";

// fixture-state:fixture
function useStore() {
  return { state: { desk: { properties: [] } }, dispatch: () => {
  } };
}

// src/lib/portal-job.ts
function alwaysAllowOfferLabel(label) {
  const trimmed = label.trim();
  if (!trimmed) return "Always allow";
  return `Always allow ${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
}

// src/lib/tool-label.ts
var STREET = /\b(?:\d+\/)?\d+[A-Za-z]?\s+[A-Z][A-Za-z']+(?:\s+[A-Z][A-Za-z']+)*\s+(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Ct|Court|Pl|Place|Cres|Crescent|Hwy|Highway|Pde|Parade|Tce|Terrace|Ln|Lane|Blvd|Boulevard|Way|Cl|Close)\b/;
var LABELED_PLACE = /\b(?:for|at|property|address|case)\s*[:#]\s*([^\n,;]{2,48})/i;
var ALIAS = {
  bud_connected_app_action: "reviewing Bud's connected-app action",
  read_file: "reading a file",
  read: "reading a file",
  write_file: "writing a file",
  write: "writing a file",
  edit: "writing a file",
  web_search: "searching the web",
  search: "searching the web",
  fetch: "reading a web page",
  http: "reading a web page",
  web_fetch: "reading a web page",
  webfetch: "reading a web page",
  shell: "running a command in the workroom",
  bash: "running a command in the workroom",
  terminal: "running a command in the workroom",
  browser: "using the bounded browser",
  computer: "using the bounded browser",
  todo: "organising the steps",
  todo_write: "updating the work plan",
  session_search: "finding previous work",
  session_search_tool: "finding previous work",
  session_read: "reading previous work",
  delegate_task: "checking part of the work in parallel",
  vision_analyze: "reading an image",
  image: "reading an image",
  execute_code: "calculating in the workroom"
};
function normalizeToolId(name) {
  return name.trim().replace(/^mcp__[^_]+__/, "").replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase();
}
function tokens(id) {
  return id.split(/[^a-z0-9]+/).filter(Boolean);
}
function humanise(id) {
  return id.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}
function toolLabel(name) {
  const id = normalizeToolId(name);
  if (!id) return "working";
  if (id.includes("desk")) return "reading the Desk book";
  const exact = ALIAS[id];
  if (exact) return exact;
  for (const token of tokens(id)) {
    const mapped = ALIAS[token];
    if (mapped) return mapped;
  }
  return humanise(id) || name;
}
function approvalPlace(payload, knownAddresses = []) {
  const text = payload.trim();
  if (!text) return null;
  for (const address of knownAddresses) {
    const street2 = address.split(",")[0]?.trim() || address;
    if (street2 && text.includes(street2)) return street2;
    if (text.includes(address)) return street2;
  }
  const street = text.match(STREET);
  if (street) return street[0].replace(/,/g, "").trim();
  const labeled = text.match(LABELED_PLACE);
  if (labeled) {
    const value = labeled[1]?.replace(/^[·•]\s*/, "").trim();
    if (value) return value.split(",")[0]?.trim() || value;
  }
  return null;
}
function approvalHeadline(tool, payload, knownAddresses = []) {
  const action = toolLabel(tool);
  const place = approvalPlace(payload, knownAddresses);
  if (place) return `For ${place} \xB7 ${action}`;
  return action.charAt(0).toUpperCase() + action.slice(1);
}

// src/lib/cn.ts
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// shared/approval-policy.ts
var HERMES_MEMORY_APPROVAL = "hermes_memory_write";
function validMemoryApprovalReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value;
  return Object.keys(row).length === 3 && row.complete === true && (row.description === "Save to memory: add to memory" || row.description === "Save to memory: add to user profile") && typeof row.content === "string" && row.content.trim().length > 0 && new TextEncoder().encode(row.content).byteLength <= 65536;
}
function requiresOnceApproval(value) {
  return value.approvalPolicy === "once" || value.tool === HERMES_MEMORY_APPROVAL;
}

// src/components/PendingApproval.tsx
import { Fragment, jsx as jsx2, jsxs } from "react/jsx-runtime";
function payloadText(pending) {
  return [pending.detail, pending.held, pending.allowKey, pending.message.card?.title].filter(Boolean).join("\n");
}
function legacyLabel(tool) {
  const nice = {
    Bash: "Command approval requested",
    shell: "Command approval requested",
    Read: "File-read approval requested",
    Write: "File-change approval requested",
    Edit: "File-change approval requested",
    edit: "File-change approval requested"
  };
  return nice[tool] ?? "Approval requested";
}
var PendingApprovalPanel = memo(function PendingApprovalPanel2({
  pending,
  count,
  index,
  productAsk = false
}) {
  const { state } = useStore();
  const isMemory = pending.tool === HERMES_MEMORY_APPROVAL;
  const memoryReview = isMemory && validMemoryApprovalReview(pending.memoryReview) ? pending.memoryReview : null;
  const knownAddresses = productAsk ? (state.desk?.properties ?? []).map((row) => row.address) : [];
  const headline = isMemory ? "Review a memory change" : productAsk ? approvalHeadline(pending.tool, payloadText(pending), knownAddresses) : legacyLabel(pending.tool);
  const isSubmit = !isMemory && pending.fence?.surface === "portal-submit";
  return /* @__PURE__ */ jsxs("div", { className: cn("rounded-t-2xl border-b px-4 py-3", productAsk ? "border-line bg-sheet" : "border-hairline/50 bg-raised/40"), children: [
    /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center gap-2", children: [
      /* @__PURE__ */ jsx2("span", { className: cn("text-[11px] uppercase tracking-[0.18em]", productAsk ? "text-ink-muted" : "text-ink-secondary"), children: "Pending approval" }),
      count > 1 && /* @__PURE__ */ jsxs("span", { className: "rounded-full bg-raised px-1.5 py-0.5 text-[11px] tabular-nums text-ink-secondary", children: [
        index + 1,
        " of ",
        count
      ] }),
      /* @__PURE__ */ jsx2("span", { className: "text-[13px] text-ink", title: pending.tool, children: headline }),
      !productAsk && /* @__PURE__ */ jsx2("span", { className: "font-mono text-[11px] text-ink-muted", children: pending.tool })
    ] }),
    isMemory ? /* @__PURE__ */ jsxs("div", { className: "mt-2 space-y-2", children: [
      /* @__PURE__ */ jsx2("p", { className: "text-[13px] leading-relaxed text-ink", children: "This changes information Bud can use in future conversations. Check the complete change before allowing it." }),
      memoryReview ? /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx2("p", { className: "whitespace-pre-wrap break-words text-[13px] font-medium text-ink", children: memoryReview.description }),
        /* @__PURE__ */ jsx2("pre", { tabIndex: 0, role: "region", "aria-label": "Complete proposed memory change", className: "max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink focus-visible:outline-2 focus-visible:outline-agency", children: memoryReview.content })
      ] }) : /* @__PURE__ */ jsx2("p", { role: "alert", className: "text-[13px] text-hold", children: "The complete memory change is unavailable. This request stays blocked. Deny it or stop this turn." }),
      /* @__PURE__ */ jsx2("p", { className: "text-[12px] text-ink-muted", children: "Approval applies to this memory change only; it does not confirm the change has finished. Future changes require their own review." })
    ] }) : isSubmit ? /* @__PURE__ */ jsx2("p", { className: "mt-2 text-[15px] font-medium leading-relaxed text-ink", children: pending.detail }) : /* @__PURE__ */ jsx2("pre", { className: "mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink", children: pending.detail }),
    isSubmit ? /* @__PURE__ */ jsx2("p", { className: "mt-2 text-[12.5px] text-hold", children: "Check the form in the browser before you allow." }) : null,
    productAsk && !isMemory && /* @__PURE__ */ jsx2(ApprovalScope, { kind: "action" }),
    pending.held && /* @__PURE__ */ jsx2("div", { className: "mt-2 text-[12px] text-hold", children: pending.held })
  ] });
});
function PendingApprovalActions({
  pending,
  threadId,
  bot,
  onCancelTurn,
  alwaysAllowable = true,
  productAsk = false
}) {
  const { dispatch } = useStore();
  const isMemory = pending.tool === HERMES_MEMORY_APPROVAL;
  const memoryReviewAvailable = !isMemory || validMemoryApprovalReview(pending.memoryReview);
  const onceOnly = requiresOnceApproval(pending);
  const productBud = productAsk || bot?.id === "bud" || bot?.name === "Bud";
  const isSubmit = !isMemory && pending.fence?.surface === "portal-submit";
  const ruleOffer = isSubmit || onceOnly ? null : pending.fence?.ruleOffer ?? null;
  const decide = (behavior, options) => {
    if (behavior === "allow" && !memoryReviewAvailable) return;
    return dispatch({
      type: "decideRequest",
      threadId,
      requestId: pending.requestId,
      behavior,
      message: behavior === "deny" ? "Denied by the user." : void 0,
      scope: behavior === "allow" && onceOnly ? "once" : options?.scope,
      rule: onceOnly ? void 0 : options?.rule,
      alwaysAllow: !onceOnly && options?.always && bot && pending.allowKey ? { botId: bot.id, key: pending.allowKey } : void 0
    });
  };
  const base = "pm-control rounded-full px-3.5 text-[13.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  return /* @__PURE__ */ jsxs("div", { className: "flex flex-col items-end gap-2 px-2 py-2", children: [
    /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center justify-end gap-2", children: [
      isSubmit ? /* @__PURE__ */ jsx2(
        "button",
        {
          type: "button",
          onClick: () => decide("allow", { scope: "once" }),
          className: cn("pm-decision rounded-full px-3.5 text-[13.5px] font-medium transition-colors", "bg-agency text-white hover:bg-agency-hover"),
          children: "Allow this Submit"
        }
      ) : /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx2(
          "button",
          {
            type: "button",
            disabled: !memoryReviewAvailable,
            onClick: () => decide("allow", { scope: "once" }),
            className: cn(base, productBud ? "border border-line text-ink hover:bg-raised" : "bg-agency font-medium text-white hover:bg-agency-hover"),
            children: isMemory ? "Allow this memory change once" : "Allow once"
          }
        ),
        productBud && !onceOnly && !pending.fence && pending.tool !== "bud_connected_app_action" && /* @__PURE__ */ jsx2(
          "button",
          {
            type: "button",
            onClick: () => decide("allow", { scope: "session" }),
            title: "Allow matching low-risk steps for this Bud task. Sensitive or consequential steps can still ask.",
            className: cn(base, "bg-agency font-medium text-white hover:bg-agency-hover"),
            children: "Allow for this task"
          }
        )
      ] }),
      alwaysAllowable && !onceOnly && bot && pending.allowKey && !productBud && pending.tool !== "bud_connected_app_action" && /* @__PURE__ */ jsx2(
        "button",
        {
          type: "button",
          onClick: () => decide("allow", { always: true }),
          title: `Save a rule: stop asking about ${pending.allowKey}`,
          className: cn(base, "border border-line text-ink hover:bg-raised"),
          children: "Always allow"
        }
      ),
      /* @__PURE__ */ jsx2(
        "button",
        {
          type: "button",
          onClick: () => decide("deny"),
          className: cn(base, "border border-danger/40 text-danger hover:bg-danger/10"),
          children: "Deny"
        }
      ),
      /* @__PURE__ */ jsx2(
        "button",
        {
          type: "button",
          onClick: onCancelTurn,
          className: cn(base, "text-ink-muted hover:bg-raised hover:text-ink"),
          children: "Stop this turn"
        }
      )
    ] }),
    ruleOffer ? /* @__PURE__ */ jsxs("div", { className: "flex w-full max-w-full flex-col items-end gap-1", children: [
      /* @__PURE__ */ jsx2(
        "button",
        {
          type: "button",
          onClick: () => decide("allow", { scope: "once", rule: { surface: ruleOffer.surface, origin: ruleOffer.origin } }),
          className: cn(base, "border border-line text-ink hover:bg-raised"),
          children: alwaysAllowOfferLabel(ruleOffer.label)
        }
      ),
      /* @__PURE__ */ jsx2("p", { className: "text-[12px] text-ink-muted", children: "Saved as a standing rule. Revoke it any time on You \u2192 Bud's rules." })
    ] }) : null
  ] });
}

// <stdin>
var content = "git is our preferred change tracker\n" + Array.from({ length: 24 }, (_, i) => "Fictional memory line " + (i + 1) + ": review this complete content before allowing.").join("\n") + "\nFINAL MEMORY LINE";
function render(complete, description = "Save to memory: add to memory") {
  const pending = { message: { id: "fixture", role: "bot", kind: "options", at: 1 }, requestId: "fictional-request", tool: "hermes_memory_write", detail: "Fictional native memory request", approvalPolicy: "once", ...complete ? { memoryReview: { description, content, complete: true } } : {}, allowKey: "Bash:git" };
  return renderToStaticMarkup(createElement(Fragment2, null, createElement(PendingApprovalPanel, { pending, count: 1, index: 0, productAsk: true }), createElement(PendingApprovalActions, { pending, threadId: "fictional-thread", bot: { id: "bud", name: "Bud" }, productAsk: true, onCancelTurn: () => {
  } })));
}
export {
  render
};
