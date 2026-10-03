import { useId, useRef, useState, type ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import "./askSparkMarkdown.css";

/** Links are optional navigation; assistant content never starts a resource fetch. */
export function safeAskSparkMarkdownUrl(value: string): string | undefined {
  if (!value || Array.from(value).some(character => character <= " " || character === "\u007f" || character === "\\")) return undefined;
  try {
    const parsed = new URL(value, "https://sparkstudio.invalid");
    if (!["http:", "https:", "mailto:"].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    return value;
  } catch { return undefined; }
}

function MarkdownLink({ href, title, children, id, "aria-label": label, "aria-describedby": describedBy, footnoteLabelId }: ComponentProps<"a"> & { footnoteLabelId?: string }) {
  const safe = href && safeAskSparkMarkdownUrl(href);
  return safe ? <a href={safe} id={id} title={title} aria-label={label} aria-describedby={describedBy === "footnote-label" ? footnoteLabelId : describedBy} target={safe.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span>;
}

function MarkdownImage({ src, alt, title }: ComponentProps<"img">) {
  return <span className="ask-spark-image-reference"><MarkdownLink href={typeof src === "string" ? src : undefined} title={title}>Image: {alt || "Open image"}</MarkdownLink></span>;
}

export function AskSparkCodeBlock({ children }: ComponentProps<"pre">) {
  const block = useRef<HTMLPreElement>(null), [message, setMessage] = useState("");
  const copy = async () => {
    try { await navigator.clipboard.writeText(block.current?.textContent || ""); setMessage("Copied"); }
    catch { setMessage("Copy unavailable. Select the code to copy it."); }
  };
  return <div className="ask-spark-code-block"><div className="ask-spark-code-heading"><span>Code</span><span className="ask-spark-code-status" role="status">{message}</span><button type="button" onClick={() => void copy()} aria-label="Copy code">Copy</button></div><pre ref={block} tabIndex={0} aria-label="Code block">{children}</pre></div>;
}

function MarkdownTable({ children }: ComponentProps<"table">) {
  return <div className="ask-spark-markdown-table" role="region" aria-label="Table; scroll horizontally to see more columns" tabIndex={0}><table>{children}</table></div>;
}

const components: Components = { a: MarkdownLink, img: MarkdownImage, pre: AskSparkCodeBlock, table: MarkdownTable };
const allowedElements = ["a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "img", "input", "li", "ol", "p", "pre", "section", "strong", "sup", "table", "tbody", "td", "th", "thead", "tr", "ul"];

export default function AskSparkMarkdown({ text }: { text: string }) {
  const id = useId(), footnoteLabelId = `ask-spark-${id}-footnote-label`;
  const scopedComponents: Components = { ...components, a: props => <MarkdownLink {...props} footnoteLabelId={footnoteLabelId} />, h2: ({ children, id }) => <h2 id={id === "footnote-label" ? footnoteLabelId : id}>{children}</h2> };
  return <div className="ask-spark-answer ask-spark-markdown"><Markdown remarkPlugins={[remarkGfm]} remarkRehypeOptions={{ clobberPrefix: `ask-spark-${id}-` }} skipHtml allowedElements={allowedElements} urlTransform={safeAskSparkMarkdownUrl} components={scopedComponents}>{text}</Markdown></div>;
}
