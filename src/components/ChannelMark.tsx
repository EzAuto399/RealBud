import { MessageCircle } from "lucide-react";

/** Decorative mark; the adjacent channel name supplies the accessible label. */
export function ChannelMark({ channel }: { channel: "Telegram" | "Discord" | "Slack" }) {
  if (channel !== "Telegram") return <MessageCircle size={24} aria-hidden="true" />;
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="12" fill="#229ED9" />
      <path fill="white" d="M5.5 11.7c3.5-1.5 5.8-2.5 7-3 3.3-1.4 4-1.7 4.5-1.7.1 0 .4 0 .5.2.1.1.1.3.1.4 0 .2-.1.6-.1.9-.5 2.9-1.1 6.2-1.4 7.7-.1.6-.3.8-.5.9-.5 0-.8-.3-1.3-.6l-2.1-1.4c-.9-.6-.3-1 .2-1.5l3.1-2.9c.1-.2 0-.3-.2-.2l-4.5 3c-.3.2-.6.3-.9.3-.4 0-1.3-.3-2-.5-.9-.3-1.6-.4-1.5-.9 0-.2.3-.4 1.1-.7Z" />
    </svg>
  );
}
