import { useState, useRef } from "react";
import { Upload, Sparkles, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import StudyKitResults from "@/components/StudyKitResults";

type StudyKit = {
  summary: string;
  flashcards: { question: string; answer: string }[];
  quiz: { question: string; options: string[]; answer: string }[];
  mindmap: string;
  practice_questions: string[];
  study_plan: string;
};

const ACCEPTED_TYPES = ".pdf,.docx,.doc,.txt,.jpg,.jpeg,.png";

export default function StudyKitGenerator() {
  const [file, setFile] = useState<File | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<StudyKit | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  };

  const handleGenerate = async () => {
    if (!file) return;

    if (file.size > 20 * 1024 * 1024) {
      toast({ title: "File too large", description: "Max 20MB.", variant: "destructive" });
      return;
    }

    setIsGenerating(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/generate-study-kit`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
        },
        body: formData,
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(err.error || `Error ${resp.status}`);
      }

      const data: StudyKit = await resp.json();
      setResult(data);

      // Scroll to results after render
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 100);
    } catch (err: any) {
      console.error(err);
      toast({ title: "Generation failed", description: err.message, variant: "destructive" });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleReset = () => {
    setFile(null);
    setResult(null);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center px-4 py-16">
      <div className="w-full max-w-xl text-center space-y-8">
        {/* Branding */}
        <div className="space-y-3">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-primary/10 rounded-full text-sm font-medium text-primary">
            <Sparkles className="w-4 h-4" />
            AI-Powered
          </div>
          <h1 className="text-4xl md:text-5xl font-heading font-bold">
            AI Study Kit Generator
          </h1>
          <p className="text-muted-foreground text-lg max-w-md mx-auto">
            Upload your notes and get a complete study kit — summary, flashcards, quiz, mind map, practice questions, and a 7-day plan.
          </p>
        </div>

        {/* Upload area */}
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleFileDrop}
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed rounded-2xl p-12 cursor-pointer transition-colors hover:border-primary hover:bg-primary/5 flex flex-col items-center gap-4"
        >
          {file ? (
            <>
              <FileText className="w-12 h-12 text-primary" />
              <div>
                <p className="font-medium">{file.name}</p>
                <p className="text-sm text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</p>
              </div>
              <p className="text-xs text-muted-foreground">Click to change file</p>
            </>
          ) : (
            <>
              <Upload className="w-12 h-12 text-muted-foreground" />
              <div>
                <p className="font-medium">Drop your notes here</p>
                <p className="text-sm text-muted-foreground">or click to browse</p>
              </div>
              <p className="text-xs text-muted-foreground">PDF, DOCX, TXT, JPG, PNG — max 20MB</p>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_TYPES}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setFile(f);
            }}
          />
        </div>

        {/* Generate button */}
        <Button
          size="lg"
          className="w-full max-w-xs text-lg h-14"
          disabled={!file || isGenerating}
          onClick={handleGenerate}
        >
          {isGenerating ? (
            <>
              <Loader2 className="w-5 h-5 mr-2 animate-spin" />
              Generating…
            </>
          ) : (
            <>
              <Sparkles className="w-5 h-5 mr-2" />
              Generate Study Kit
            </>
          )}
        </Button>
      </div>

      {/* Results section — only visible after generation */}
      {result && (
        <div ref={resultsRef} className="w-full max-w-3xl mt-16 pt-10 border-t">
          <StudyKitResults data={result} fileName={file?.name || "notes"} onReset={handleReset} />
        </div>
      )}
    </div>
  );
}
