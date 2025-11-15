import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface QuizGeneratorProps {
  documentId: string;
  documentTitle: string;
  onGenerate: (documentId: string, startPage?: number, endPage?: number) => void;
}

export default function QuizGenerator({ documentId, documentTitle, onGenerate }: QuizGeneratorProps) {
  const [startPage, setStartPage] = useState("");
  const [endPage, setEndPage] = useState("");
  const [showOptions, setShowOptions] = useState(false);

  const handleGenerate = () => {
    const start = startPage ? parseInt(startPage) : undefined;
    const end = endPage ? parseInt(endPage) : undefined;
    onGenerate(documentId, start, end);
    setShowOptions(false);
  };

  if (!showOptions) {
    return (
      <Button size="sm" variant="outline" onClick={() => setShowOptions(true)}>
        Generate Quiz
      </Button>
    );
  }

  return (
    <Card className="mt-2">
      <CardHeader>
        <CardTitle className="text-base">Quiz Options</CardTitle>
        <CardDescription>Customize your quiz for {documentTitle}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
          <p className="text-xs text-muted-foreground">Leave empty for entire document. Quiz will have 10 questions.</p>
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
