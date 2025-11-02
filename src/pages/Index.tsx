import { useRef, useEffect } from "react";
import { BookOpen, Sparkles, Trash2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import ChatMessage from "@/components/ChatMessage";
import ChatInput from "@/components/ChatInput";
import { useStudyChat } from "@/hooks/useStudyChat";
import { useNavigate } from "react-router-dom";
import heroImage from "@/assets/hero-study.jpg";

const Index = () => {
  const { messages, isLoading, sendMessage, clearChat } = useStudyChat();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section */}
      <header className="relative overflow-hidden">
        <div 
          className="absolute inset-0 bg-cover bg-center opacity-20"
          style={{ backgroundImage: `url(${heroImage})` }}
        />
        <div className="absolute inset-0 bg-gradient-hero opacity-90" />
        
        <div className="relative container mx-auto px-4 py-16 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-card/50 backdrop-blur-sm rounded-full border border-border mb-6 animate-in fade-in slide-in-from-top-4 duration-700">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium">AI-Powered Learning</span>
          </div>
          
          <h1 className="text-5xl md:text-6xl font-bold mb-6 bg-clip-text text-transparent bg-gradient-to-r from-primary to-secondary animate-in fade-in slide-in-from-top-6 duration-700">
            Your AI Study Assistant
          </h1>
          
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto mb-8 animate-in fade-in slide-in-from-top-8 duration-700">
            Get instant help with your studies. Ask questions, clarify concepts, and learn more effectively with AI-powered assistance.
          </p>

          <Button 
            size="lg" 
            onClick={() => navigate('/auth')}
            className="mb-8 animate-in fade-in slide-in-from-top-9 duration-700"
          >
            Get Started
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>

          <div className="flex items-center justify-center gap-6 text-sm text-muted-foreground animate-in fade-in slide-in-from-top-10 duration-700">
            <div className="flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-primary" />
              <span>Any Subject</span>
            </div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-secondary" />
              <span>Instant Answers</span>
            </div>
          </div>
        </div>
      </header>

      {/* Chat Section */}
      <main className="container mx-auto px-4 py-8 max-w-4xl">
        <div className="bg-card border border-border rounded-2xl shadow-elevated p-6 mb-6">
          {/* Chat Header */}
          <div className="flex items-center justify-between mb-6 pb-4 border-b border-border">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <BookOpen className="w-5 h-5 text-primary" />
              Study Session
            </h2>
            {messages.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearChat}
                className="text-muted-foreground hover:text-foreground"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Clear
              </Button>
            )}
          </div>

          {/* Messages */}
          <div className="min-h-[400px] max-h-[500px] overflow-y-auto mb-6 pr-2">
            {messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-[400px] text-center">
                <div className="w-16 h-16 bg-gradient-primary rounded-full flex items-center justify-center mb-4 shadow-glow">
                  <Sparkles className="w-8 h-8 text-primary-foreground" />
                </div>
                <h3 className="text-lg font-semibold mb-2">Ready to learn?</h3>
                <p className="text-muted-foreground max-w-md">
                  Ask me anything about your studies. I can help explain concepts, solve problems, or answer questions.
                </p>
              </div>
            ) : (
              <>
                {messages.map((message, index) => (
                  <ChatMessage
                    key={index}
                    role={message.role}
                    content={message.content}
                  />
                ))}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Input */}
          <ChatInput onSend={sendMessage} isLoading={isLoading} />
        </div>

        {/* Quick Tips */}
        <div className="grid md:grid-cols-3 gap-4 mb-8">
          {[
            { title: "Explain Concepts", desc: "Break down complex topics into simple terms" },
            { title: "Solve Problems", desc: "Get step-by-step guidance on homework" },
            { title: "Study Tips", desc: "Learn effective study techniques" },
          ].map((tip, i) => (
            <div
              key={i}
              className="p-4 bg-gradient-card border border-border rounded-xl shadow-soft hover:shadow-elevated transition-all duration-300 cursor-pointer"
            >
              <h3 className="font-semibold mb-1">{tip.title}</h3>
              <p className="text-sm text-muted-foreground">{tip.desc}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
};

export default Index;
