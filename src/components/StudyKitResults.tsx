import { useState } from "react";
import { ChevronDown, BookOpen, Brain, HelpCircle, Map, PenLine, Calendar, Download, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { generateStudyKitPDF } from "@/lib/generatePDF";

interface StudyKit {
  summary: string;
  flashcards: { question: string; answer: string }[];
  quiz: { question: string; options: string[]; answer: string }[];
  mindmap: string;
  practice_questions: string[];
  study_plan: string;
}

interface Props {
  data: StudyKit;
  fileName: string;
  onReset: () => void;
}

export default function StudyKitResults({ data, fileName, onReset }: Props) {
  const [flippedCards, setFlippedCards] = useState<Set<number>>(new Set());
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, string>>({});
  const [showQuizAnswers, setShowQuizAnswers] = useState(false);

  const toggleCard = (index: number) => {
    setFlippedCards(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleDownloadPDF = () => {
    generateStudyKitPDF(data, fileName);
  };

  return (
    <div className="w-full max-w-3xl mx-auto space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-3xl font-heading font-bold">Your Study Kit</h2>
        <p className="text-muted-foreground">Generated from: {fileName}</p>
        <div className="flex justify-center gap-3 pt-2">
          <Button onClick={handleDownloadPDF} size="lg">
            <Download className="w-4 h-4 mr-2" />
            Download as PDF
          </Button>
          <Button variant="outline" onClick={onReset} size="lg">
            <RotateCcw className="w-4 h-4 mr-2" />
            New Upload
          </Button>
        </div>
      </div>

      <Accordion type="multiple" defaultValue={["summary"]} className="space-y-3">
        {/* Summary */}
        <AccordionItem value="summary" className="border rounded-xl px-4 bg-card">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <BookOpen className="w-4 h-4 text-primary" />
              </div>
              <span className="font-semibold text-lg">Summary</span>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <div className="prose prose-sm max-w-none text-foreground whitespace-pre-wrap leading-relaxed pt-2 pb-4">
              {data.summary}
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Flashcards */}
        <AccordionItem value="flashcards" className="border rounded-xl px-4 bg-card">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-secondary/10 flex items-center justify-center">
                <Brain className="w-4 h-4 text-secondary" />
              </div>
              <span className="font-semibold text-lg">Flashcards ({data.flashcards.length})</span>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <div className="grid gap-3 pt-2 pb-4 sm:grid-cols-2">
              {data.flashcards.map((card, i) => (
                <Card
                  key={i}
                  className="cursor-pointer hover:shadow-md transition-shadow"
                  onClick={() => toggleCard(i)}
                >
                  <CardContent className="p-4 min-h-[120px] flex flex-col justify-center">
                    {flippedCards.has(i) ? (
                      <>
                        <p className="text-xs font-medium text-primary mb-1">Answer</p>
                        <p className="text-sm">{card.answer}</p>
                      </>
                    ) : (
                      <>
                        <p className="text-xs font-medium text-muted-foreground mb-1">Question {i + 1}</p>
                        <p className="text-sm font-medium">{card.question}</p>
                        <p className="text-xs text-muted-foreground mt-2">Tap to reveal</p>
                      </>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Quiz */}
        <AccordionItem value="quiz" className="border rounded-xl px-4 bg-card">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center">
                <HelpCircle className="w-4 h-4 text-accent" />
              </div>
              <span className="font-semibold text-lg">Quiz ({data.quiz.length} questions)</span>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <div className="space-y-6 pt-2 pb-4">
              {data.quiz.map((q, i) => {
                const letters = ['A', 'B', 'C', 'D'];
                return (
                  <div key={i} className="space-y-2">
                    <p className="font-medium text-sm">{i + 1}. {q.question}</p>
                    <div className="grid gap-1.5">
                      {q.options.map((opt, j) => {
                        const letter = letters[j];
                        const isSelected = selectedAnswers[i] === letter;
                        const isCorrect = showQuizAnswers && letter === q.answer;
                        const isWrong = showQuizAnswers && isSelected && letter !== q.answer;
                        return (
                          <button
                            key={j}
                            onClick={() => !showQuizAnswers && setSelectedAnswers(prev => ({ ...prev, [i]: letter }))}
                            className={`text-left text-sm px-3 py-2 rounded-lg border transition-colors ${
                              isCorrect ? 'bg-green-100 border-green-400 dark:bg-green-900/30 dark:border-green-600' :
                              isWrong ? 'bg-red-100 border-red-400 dark:bg-red-900/30 dark:border-red-600' :
                              isSelected ? 'bg-primary/10 border-primary' :
                              'hover:bg-muted'
                            }`}
                          >
                            <span className="font-medium">{letter}.</span> {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowQuizAnswers(!showQuizAnswers)}
              >
                {showQuizAnswers ? 'Hide Answers' : 'Check Answers'}
              </Button>
            </div>
          </AccordionContent>
        </AccordionItem>

        {/* Mind Map */}
        <AccordionItem value="mindmap" className="border rounded-xl px-4 bg-card">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Map className="w-4 h-4 text-primary" />
              </div>
              <span className="font-semibold text-lg">Mind Map</span>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <pre className="text-sm whitespace-pre-wrap leading-relaxed font-sans pt-2 pb-4">
              {data.mindmap}
            </pre>
          </AccordionContent>
        </AccordionItem>

        {/* Practice Questions */}
        <AccordionItem value="practice" className="border rounded-xl px-4 bg-card">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-secondary/10 flex items-center justify-center">
                <PenLine className="w-4 h-4 text-secondary" />
              </div>
              <span className="font-semibold text-lg">Practice Questions ({data.practice_questions.length})</span>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <ol className="list-decimal list-inside space-y-3 text-sm pt-2 pb-4">
              {data.practice_questions.map((q, i) => (
                <li key={i} className="leading-relaxed">{q}</li>
              ))}
            </ol>
          </AccordionContent>
        </AccordionItem>

        {/* Study Plan */}
        <AccordionItem value="studyplan" className="border rounded-xl px-4 bg-card">
          <AccordionTrigger className="hover:no-underline">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center">
                <Calendar className="w-4 h-4 text-accent" />
              </div>
              <span className="font-semibold text-lg">7-Day Study Plan</span>
            </div>
          </AccordionTrigger>
          <AccordionContent>
            <div className="prose prose-sm max-w-none text-foreground whitespace-pre-wrap leading-relaxed pt-2 pb-4">
              {data.study_plan}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
