import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface FlashcardGeneratorProps {
  documentId: string;
  documentTitle: string;
  onGenerate: (documentId: string, count: number, difficulty: string, startPage?: number, endPage?: number) => void;
}

export default function FlashcardGenerator({ documentId, documentTitle, onGenerate }: FlashcardGeneratorProps) {
  const [count, setCount] = useState("10");
  const [difficulty, setDifficulty] = useState("mixed");
  const [startPage, setStartPage] = useState("");
  const [endPage, setEndPage] = useState("");
  const [showOptions, setShowOptions] = useState(false);

  const handleGenerate = () => {
    const start = startPage ? parseInt(startPage) : undefined;
    const end = endPage ? parseInt(endPage) : undefined;
    onGenerate(documentId, parseInt(count), difficulty, start, end);
    setShowOptions(false);
  };

  if (!showOptions) {
    return (
      <Button size="sm" variant="outline" onClick={() => setShowOptions(true)}>
        Generate Flashcards
      </Button>
    );
  }

  return (
    <Card className="mt-2">
      <CardHeader>
        <CardTitle className="text-base">Flashcard Options</CardTitle>
        <CardDescription>Customize your flashcards for {documentTitle}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Number of flashcards</Label>
          <Select value={count} onValueChange={setCount}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5">5 flashcards</SelectItem>
              <SelectItem value="10">10 flashcards</SelectItem>
              <SelectItem value="15">15 flashcards</SelectItem>
              <SelectItem value="20">20 flashcards</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Difficulty level</Label>
          <Select value={difficulty} onValueChange={setDifficulty}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="easy">Easy only</SelectItem>
              <SelectItem value="medium">Medium only</SelectItem>
              <SelectItem value="hard">Hard only</SelectItem>
              <SelectItem value="mixed">Mixed difficulty</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Page Range (Optional)</Label>
          <div className="flex gap-2">
            <Input
              type="number"
              placeholder="Start"
              min="1"
              value={startPage}
              onChange={(e) => setStartPage(e.target.value)}
            />
            <Input
              type="number"
              placeholder="End"
              min="1"
              value={endPage}
              onChange={(e) => setEndPage(e.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">Leave empty for entire document</p>
        </div>

        <div className="flex gap-2">
          <Button onClick={handleGenerate} className="flex-1">
            Generate
          </Button>
          <Button variant="outline" onClick={() => setShowOptions(false)}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
