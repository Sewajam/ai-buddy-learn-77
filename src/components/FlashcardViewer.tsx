import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, ArrowLeft, BookOpen, Trash2 } from 'lucide-react';

interface Flashcard {
  id: string;
  question: string;
  answer: string;
  difficulty: string;
}

interface FlashcardSet {
  id: string;
  title: string;
  card_count: number;
  difficulty: string;
  created_at: string;
  flashcards: Flashcard[];
}

interface FlashcardViewerProps {
  flashcards: FlashcardSet[];
  onDelete?: (setId: string) => void;
}

export default function FlashcardViewer({ flashcards, onDelete }: FlashcardViewerProps) {
  const [selectedSet, setSelectedSet] = useState<FlashcardSet | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);

  if (!selectedSet) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {flashcards.map((set) => (
          <Card 
            key={set.id} 
            className="hover:shadow-lg transition-shadow"
          >
            <CardHeader>
              <div className="flex items-start justify-between">
                <div 
                  className="flex-1 cursor-pointer"
                  onClick={() => {
                    setSelectedSet(set);
                    setCurrentIndex(0);
                    setShowAnswer(false);
                  }}
                >
                  <CardTitle className="text-lg flex items-center gap-2">
                    <BookOpen className="h-5 w-5" />
                    {set.title}
                  </CardTitle>
                  <CardDescription>
                    {set.card_count} cards • Created {new Date(set.created_at).toLocaleDateString()}
                  </CardDescription>
                </div>
                {onDelete && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(set.id);
                    }}
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent 
              className="cursor-pointer"
              onClick={() => {
                setSelectedSet(set);
                setCurrentIndex(0);
                setShowAnswer(false);
              }}
            >
              <div className="flex items-center gap-2">
                <span className={`text-xs px-2 py-1 rounded ${
                  set.difficulty === 'easy' ? 'bg-green-100 text-green-800' :
                  set.difficulty === 'medium' ? 'bg-yellow-100 text-yellow-800' :
                  set.difficulty === 'hard' ? 'bg-red-100 text-red-800' :
                  'bg-blue-100 text-blue-800'
                }`}>
                  {set.difficulty === 'mixed' ? 'Mixed Difficulty' : set.difficulty}
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const currentCard = selectedSet.flashcards?.[currentIndex];

  // Handle empty flashcards
  if (!currentCard) {
    return (
      <div className="space-y-4">
        <Button 
          variant="outline" 
          onClick={() => setSelectedSet(null)}
          className="mb-4"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Sets
        </Button>
        <Card>
          <CardHeader>
            <CardTitle>No Flashcards Available</CardTitle>
            <CardDescription>
              This set has no flashcards or they failed to load.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => setSelectedSet(null)} className="w-full">
              Back to Sets
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const handleNext = () => {
    if (currentIndex < selectedSet.flashcards.length - 1) {
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
      <Button 
        variant="outline" 
        onClick={() => setSelectedSet(null)}
        className="mb-4"
      >
        <ArrowLeft className="h-4 w-4 mr-2" />
        Back to Sets
      </Button>

      <Card 
        className="cursor-pointer hover:shadow-lg transition-all min-h-[300px] flex flex-col"
        onClick={() => setShowAnswer(!showAnswer)}
      >
        <CardHeader>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              Card {currentIndex + 1} of {selectedSet.flashcards.length}
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
          disabled={currentIndex === selectedSet.flashcards.length - 1}
        >
          Next
          <ChevronRight className="h-4 w-4 ml-2" />
        </Button>
      </div>
    </div>
  );
}
