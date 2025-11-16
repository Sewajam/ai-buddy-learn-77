-- Create flashcard_sets table to group flashcards into decks
CREATE TABLE public.flashcard_sets (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  document_id UUID REFERENCES public.documents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  card_count INTEGER DEFAULT 0,
  difficulty TEXT
);

-- Enable RLS
ALTER TABLE public.flashcard_sets ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Users can view their own flashcard sets"
  ON public.flashcard_sets
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own flashcard sets"
  ON public.flashcard_sets
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own flashcard sets"
  ON public.flashcard_sets
  FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own flashcard sets"
  ON public.flashcard_sets
  FOR DELETE
  USING (auth.uid() = user_id);

-- Add set_id to flashcards table
ALTER TABLE public.flashcards ADD COLUMN set_id UUID REFERENCES public.flashcard_sets(id) ON DELETE CASCADE;

-- Create index for better performance
CREATE INDEX idx_flashcards_set_id ON public.flashcards(set_id);
CREATE INDEX idx_flashcard_sets_user_id ON public.flashcard_sets(user_id);