import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Flashcard {
  id: string;
  question: string;
  answer: string;
  difficulty: string;
}

interface FlashcardViewerProps {
  flashcards: Flashcard[];
}

export default function FlashcardViewer({ flashcards }: FlashcardViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);

  const currentCard = flashcards[currentIndex];

  const handleNext = () => {
    if (currentIndex < flashcards.length - 1) {
      setCurrentIndex(currentIndex + 1);
      setShowAnswer(false);
    }
  };

  const handlePrevious = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
      setShowAnswer(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card 
        className="cursor-pointer hover:shadow-lg transition-all min-h-[300px] flex flex-col"
        onClick={() => setShowAnswer(!showAnswer)}
      >
        <CardHeader>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              Card {currentIndex + 1} of {flashcards.length}
            </span>
            <span className={`text-xs px-2 py-1 rounded ${
              currentCard.difficulty === 'easy' ? 'bg-green-100 text-green-800' :
              currentCard.difficulty === 'medium' ? 'bg-yellow-100 text-yellow-800' :
              'bg-red-100 text-red-800'
            }`}>
              {currentCard.difficulty}
            </span>
          </div>
        </CardHeader>
        <CardContent className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-4 w-full">
            <div>
              <p className="text-sm font-semibold text-muted-foreground mb-2">
                {showAnswer ? 'Answer:' : 'Question:'}
              </p>
              <p className="text-lg">
                {showAnswer ? currentCard.answer : currentCard.question}
              </p>
            </div>
            {!showAnswer && (
              <p className="text-sm text-muted-foreground">
                Click to reveal answer
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2 justify-between">
        <Button
          variant="outline"
          onClick={handlePrevious}
          disabled={currentIndex === 0}
        >
          <ChevronLeft className="h-4 w-4 mr-2" />
          Previous
        </Button>
        <Button
          variant="outline"
          onClick={handleNext}
          disabled={currentIndex === flashcards.length - 1}
        >
          Next
          <ChevronRight className="h-4 w-4 ml-2" />
        </Button>
      </div>
    </div>
  );
}
