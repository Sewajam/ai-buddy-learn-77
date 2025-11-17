import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { CheckCircle, XCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface Question {
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

interface Quiz {
  id: string;
  title: string;
  questions: Question[];
}

interface QuizTakerProps {
  quiz: Quiz;
  onComplete: () => void;
}

export default function QuizTaker({ quiz, onComplete }: QuizTakerProps) {
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [selectedAnswers, setSelectedAnswers] = useState<number[]>([]);
  const [showResults, setShowResults] = useState(false);
  const { toast } = useToast();

  const questions = quiz.questions || [];
  const question = questions[currentQuestion];

  const handleAnswerSelect = (answerIndex: number) => {
    const newAnswers = [...selectedAnswers];
    newAnswers[currentQuestion] = answerIndex;
    setSelectedAnswers(newAnswers);
  };

  const handleNext = () => {
    if (currentQuestion < questions.length - 1) {
      setCurrentQuestion(currentQuestion + 1);
    }
  };

  const handlePrevious = () => {
    if (currentQuestion > 0) {
      setCurrentQuestion(currentQuestion - 1);
    }
  };

  const handleSubmit = async () => {
    const score = selectedAnswers.reduce((acc, answer, index) => {
      return acc + (answer === questions[index].correctIndex ? 1 : 0);
    }, 0);

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('User not authenticated');

      const { error } = await supabase.from('quiz_results').insert([{
        user_id: user.id,
        quiz_id: quiz.id,
        score,
        total_questions: questions.length,
        answers: selectedAnswers,
      }]);

      if (error) throw error;

      toast({
        title: "Quiz completed!",
        description: `You scored ${score} out of ${questions.length}`,
      });

      setShowResults(true);
    } catch (error: any) {
      console.error('Error saving quiz result:', error);
      toast({
        title: "Error",
        description: "Failed to save quiz results",
        variant: "destructive",
      });
    }
  };

  if (showResults) {
    const score = selectedAnswers.reduce((acc, answer, index) => {
      return acc + (answer === questions[index].correctIndex ? 1 : 0);
    }, 0);

    return (
      <Card>
        <CardHeader>
          <CardTitle>Quiz Results</CardTitle>
          <CardDescription>
            You scored {score} out of {questions.length} ({Math.round((score / questions.length) * 100)}%)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {questions.map((q, index) => {
            const isCorrect = selectedAnswers[index] === q.correctIndex;
            return (
              <Card key={index} className={isCorrect ? 'border-green-200' : 'border-red-200'}>
                <CardHeader>
                  <div className="flex items-start gap-2">
                    {isCorrect ? (
                      <CheckCircle className="h-5 w-5 text-green-600 mt-1" />
                    ) : (
                      <XCircle className="h-5 w-5 text-red-600 mt-1" />
                    )}
                    <div className="flex-1">
                      <CardTitle className="text-sm">{q.question}</CardTitle>
                      <p className="text-sm text-muted-foreground mt-2">
                        Your answer: {q.options[selectedAnswers[index]]}
                      </p>
                      {!isCorrect && (
                        <p className="text-sm text-green-600 mt-1">
                          Correct answer: {q.options[q.correctIndex]}
                        </p>
                      )}
                      <p className="text-sm text-muted-foreground mt-2">{q.explanation}</p>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            );
          })}
          <Button onClick={onComplete} className="w-full">
            Back to Quizzes
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{quiz.title}</CardTitle>
              <CardDescription>
                Question {currentQuestion + 1} of {questions.length}
              </CardDescription>
            </div>
            <Button variant="outline" onClick={onComplete}>
              Exit Quiz
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-lg mb-4">{question.question}</p>
            <RadioGroup
              value={selectedAnswers[currentQuestion] !== undefined ? selectedAnswers[currentQuestion].toString() : ""}
              onValueChange={(value) => handleAnswerSelect(parseInt(value))}
            >
              {question.options.map((option, index) => (
                <div 
                  key={index} 
                  className="flex items-center space-x-2 p-3 border rounded hover:bg-accent cursor-pointer"
                  onClick={() => handleAnswerSelect(index)}
                >
                  <RadioGroupItem value={index.toString()} id={`option-${index}`} />
                  <Label htmlFor={`option-${index}`} className="flex-1 cursor-pointer">
                    {option}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>

          <div className="flex gap-2 justify-between pt-4">
            <Button
              variant="outline"
              onClick={handlePrevious}
              disabled={currentQuestion === 0}
            >
              Previous
            </Button>
            {currentQuestion === questions.length - 1 ? (
              <Button
                onClick={handleSubmit}
                disabled={selectedAnswers.length !== questions.length}
              >
                Submit Quiz
              </Button>
            ) : (
              <Button
                onClick={handleNext}
                disabled={selectedAnswers[currentQuestion] === undefined}
              >
                Next
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
