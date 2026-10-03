// Real markdown for bot bubbles: react-markdown + GFM (tables, task lists,
// strikethrough, autolinks) with a chromed code block — language label, copy
// button, lazy Shiki highlighting. Model output never reaches the DOM as raw
// HTML: no rehype-raw, so HTML in the text renders as text; Shiki's output is
// generator-escaped. While a message is still streaming, code blocks render
// as plain <pre> and nothing is cached — partial fences would poison it.
// Only plain https links are clickable; the desktop window refuses every other
// scheme, so mailto:, tel:, http: and the rest read as text the person can copy.
import { isValidElement, memo, useEffect, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { useCopyText } from "@/lib/use-copy-text";
import { BANK_FEED_CONNECT_HREF } from "@shared/ask-controls";
import { BankFeedConnect } from "./ConnectedAppsCard";

// tiny highlight cache so revisiting a thread doesn't re-tokenize settled
// blocks; keys are content-hashed, capped, never written while streaming
const highlightCache = new Map<string, string>();
const CACHE_MAX = 200;
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

function CodeBlock({ code, lang, streaming }: { code: string; lang: string; streaming: boolean }) {
  const [highlight, setHighlight] = useState<{ code: string; lang: string; html: string } | null>(null);
  const { state: copyState, copy } = useCopyText(code);
  const html = !streaming && highlight?.code === code && highlight.lang === lang ? highlight.html : null;

  useEffect(() => {
    if (streaming) return;
    const key = `${lang}:${hash(code)}`;
    const cached = highlightCache.get(key);
    if (cached) return setHighlight({ code, lang, html: cached });
    let alive = true;
    import("shiki")
      .then((shiki) =>
        shiki.codeToHtml(code, {
          lang: lang || "text",
          theme: "github-light",
        }),
      )
      .then((out) => {
        if (!alive) return;
        if (highlightCache.size >= CACHE_MAX) {
          const first = highlightCache.keys().next().value;
          if (first) highlightCache.delete(first);
        }
        highlightCache.set(key, out);
        setHighlight({ code, lang, html: out });
      })
      .catch(() => {
        /* unknown language or shiki failed — the plain <pre> stays */
      });
    return () => {
      alive = false;
    };
  }, [code, lang, streaming]);

  return (
    <div className="chat-code-block my-2 min-w-0 overflow-hidden rounded-lg border border-line bg-sheet">
      <div className="chat-code-header flex items-center justify-between border-b border-line px-3">
        <span className="text-[12px] text-ink-secondary">{lang || "Plain text"}</span>
        <button
          type="button"
          onClick={() => void copy()}
          disabled={copyState === "copying"}
          className="flex min-h-10 items-center gap-1.5 rounded px-2 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
          aria-label={copyState === "failed" ? "Try copying code again" : "Copy code"}
        >
          {copyState === "copied" ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          {copyState === "copied" ? "Copied" : copyState === "copying" ? "Copying…" : copyState === "failed" ? "Try again" : "Copy"}
        </button>
      </div>
      <div className="chat-code-scroll overflow-x-auto" tabIndex={0} role="region" aria-label={lang ? `${lang} code` : "Code block"}>
        {html ? (
        <div
          className="text-[13px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:p-4"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="p-4 text-[13px] leading-relaxed text-ink">{code}</pre>
      )}</div>
      <span role="status" className={copyState === "failed" ? "block px-4 pb-3 text-[12px] text-ink-secondary" : "sr-only"}>{copyState === "failed" ? "Couldn’t copy. Try again, or select the code." : copyState === "copied" ? "Code copied to clipboard" : ""}</span>
    </div>
  );
}

const LINK_CLASS = "break-words text-accent underline decoration-accent/40 hover:decoration-accent";

/** The same rule as the desktop window (electron/external-links.mjs): https,
 * with no user name or password in the address. */
function opensFromChat(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

const textOf = (node: ReactNode): string =>
  typeof node === "string" || typeof node === "number" ? String(node)
    : Array.isArray(node) ? node.map(textOf).join("")
      : isValidElement<{ children?: ReactNode }>(node) ? textOf(node.props.children) : "";

/** A link that cannot open from chat, as selectable text. The address follows
 * the words unless the words already are the address (bare emails, www.). */
function LinkAsText({ href, children }: { href: string; children?: ReactNode }) {
  const words = textOf(children).trim();
  const bare = href.replace(/^(?:mailto:|tel:|https?:\/\/)/i, "");
  const showAddress = href !== "" && words !== href && words !== bare;
  return (
    <span className="break-words">
      {children}
      {showAddress && <span className="break-all text-ink-secondary"> ({href})</span>}
    </span>
  );
}

// Links keep their written address so a refused one can be shown as text; it
// never reaches an href unless it is https or a same-page #fragment. Images
// keep react-markdown's own sanitising.
const keepLinkAddress = (url: string, key: string) => (key === "href" ? url : defaultUrlTransform(url));

function ChatMarkdownComponent({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="chat-md min-w-0 [&>*+*]:mt-2">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={keepLinkAddress}
        components={{
          pre({ children }: { children?: ReactNode }) {
            // fenced code arrives as <pre><code class="language-x">…</code></pre>
            const child: any = Array.isArray(children) ? children[0] : children;
            const className: string = child?.props?.className ?? "";
            const lang = /language-([\w-]+)/.exec(className)?.[1] ?? "";
            // children can be a string OR an array of strings/nodes — flatten
            // strings only, so String() never comma-joins an array
            const flat = (n: any): string =>
              typeof n === "string" ? n : Array.isArray(n) ? n.map(flat).join("") : (n?.props?.children ? flat(n.props.children) : "");
            const code = flat(child?.props?.children).replace(/\n$/, "");
            return <CodeBlock code={code} lang={lang} streaming={streaming} />;
          },
          img({ src, alt }: { src?: string; alt?: string }) {
            return (
              <img
                src={src}
                alt={alt ?? ""}
                loading="lazy"
                className="max-h-96 max-w-full rounded-lg border border-hairline/30"
              />
            );
          },
          code({ children }: { children?: ReactNode }) {
            return (
              <code className="rounded bg-inset px-1 py-px text-[13px]">{children}</code>
            );
          },
          a({ href = "", children, node: _node, ...rest }: ComponentProps<"a"> & { node?: unknown }) {
            // footnote references and back-links stay on this page
            if (href === BANK_FEED_CONNECT_HREF) return <BankFeedConnect />;
            if (href.startsWith("#")) {
              return <a {...rest} href={href} className={LINK_CLASS}>{children}</a>;
            }
            if (!opensFromChat(href)) return <LinkAsText href={href}>{children}</LinkAsText>;
            return (
              <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
                {children}
              </a>
            );
          },
          table({ children }: { children?: ReactNode }) {
            return (
              <div className="chat-table-scroll overflow-x-auto" tabIndex={0} role="region" aria-label="Response table">
                <table className="w-full border-collapse text-[13.5px]">{children}</table>
              </div>
            );
          },
          th({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
            return (
              <th scope="col" style={style} className="border-b border-hairline/40 px-2 py-1.5 text-left font-semibold">{children}</th>
            );
          },
          td({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
            return <td style={style} className="border-b border-hairline/20 px-2 py-1.5 align-top">{children}</td>;
          },
          ul({ children, className }: { children?: ReactNode; className?: string }) {
            return <ul className={`list-disc space-y-1 pl-5${className ? ` ${className}` : ""}`}>{children}</ul>;
          },
          ol({ children, start }: { children?: ReactNode; start?: number }) {
            return <ol start={start} className="list-decimal space-y-1 pl-5">{children}</ol>;
          },
          h1({ children }: { children?: ReactNode }) {
            return <h2 className="chat-md-heading mt-2 text-[18px] font-semibold">{children}</h2>;
          },
          h2({ children }: { children?: ReactNode }) {
            return <h3 className="chat-md-heading mt-2 text-[16px] font-semibold">{children}</h3>;
          },
          h3({ children }: { children?: ReactNode }) {
            return <h4 className="chat-md-heading mt-1.5 font-semibold">{children}</h4>;
          },
          h4({ children }: { children?: ReactNode }) {
            return <h5 className="chat-md-heading mt-1.5 font-semibold">{children}</h5>;
          },
          h5({ children }: { children?: ReactNode }) {
            return <h6 className="chat-md-heading mt-1.5 text-[14px] font-semibold">{children}</h6>;
          },
          h6({ children }: { children?: ReactNode }) {
            return <h6 className="chat-md-heading mt-1.5 text-[13.5px] font-semibold text-ink-secondary">{children}</h6>;
          },
          blockquote({ children }: { children?: ReactNode }) {
            return (
              <blockquote className="border-l-2 border-hairline pl-3 text-ink-secondary">{children}</blockquote>
            );
          },
          hr() {
            return <hr className="border-hairline/40" />;
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

export const ChatMarkdown = memo(ChatMarkdownComponent);
