import { cn } from "@/lib/utils";
import { Bot, User } from "lucide-react";

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
}

const ChatMessage = ({ role, content }: ChatMessageProps) => {
  const isUser = role === "user";

  return (
    <div className={cn(
      "flex gap-3 mb-6 animate-in fade-in slide-in-from-bottom-4 duration-500",
      isUser ? "flex-row-reverse" : "flex-row"
    )}>
      <div className={cn(
        "flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center shadow-soft",
        isUser ? "bg-gradient-primary" : "bg-gradient-secondary"
      )}>
        {isUser ? (
          <User className="w-5 h-5 text-primary-foreground" />
        ) : (
          <Bot className="w-5 h-5 text-secondary-foreground" />
        )}
      </div>
      <div className={cn(
        "flex-1 rounded-xl px-4 py-3 shadow-soft max-w-[85%]",
        isUser 
          ? "bg-gradient-primary text-primary-foreground" 
          : "bg-card border border-border"
      )}>
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{content}</p>
      </div>
    </div>
  );
};

export default ChatMessage;
