// supabase/functions/generate-quiz/index.ts
// Updated: use same relevance-based chunking when falling back to AI generation to improve coverage.

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// (Re-use the same chunking, tokenization, and keyword helpers as in flashcards function)
const STOPWORDS = new Set([
  'the','and','is','in','to','of','a','that','it','on','for','as','with','was','were','be','by','an','this','which','or','are','from','at','but','not','have','has','had'
]);

function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function getTopKeywords(text: string, topK = 50): string[] {
  const tokens = tokenizeWords(text);
  const freq: Record<string, number> = {};
  for (const t of tokens) {
    if (t.length <= 2) continue;
    if (STOPWORDS.has(t)) continue;
    freq[t] = (freq[t] || 0) + 1;
  }
  const entries = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  return entries.slice(0, topK).map(e => e[0]);
}

type Chunk = { id: string; text: string; start: number; end: number; score?: number };

function chunkTextByChars(text: string, chunkSize = 2000, overlap = 300): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  let id = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const slice = text.slice(start, end).trim();
    if (slice) {
      chunks.push({ id: `c${id++}`, text: slice, start, end });
    }
    start = end - overlap;
    if (start < 0) start = 0;
    if (end === text.length) break;
  }
  return chunks;
}

function scoreChunksByKeywords(chunks: Chunk[], keywords: string[]): Chunk[] {
  if (!keywords || keywords.length === 0) return chunks;
  const kwSet = new Set(keywords);
  for (const c of chunks) {
    const tokens = tokenizeWords(c.text);
    let score = 0;
    for (const t of tokens) {
      if (kwSet.has(t)) score++;
    }
    c.score = score;
  }
  return chunks.sort((a, b) => (b.score || 0) - (a.score || 0));
}

function selectTopChunks(chunks: Chunk[], maxChars = 30000): Chunk[] {
  const selected: Chunk[] = [];
  let used = 0;
  for (const c of chunks) {
    if (used + c.text.length > maxChars) continue;
    selected.push(c);
    used += c.text.length;
    if (used >= maxChars) break;
  }
  return selected;
}

// Simple supportedBySource helper
function supportedBySource(needle: string, haystack: string): boolean {
  if (!needle || !haystack) return false;
  const n = needle.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (n.length === 0) return false;
  for (const token of n) {
    if (token.length < 3) continue;
    if (haystack.toLowerCase().includes(token)) return true;
  }
  return false;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function detectLanguageByStopwords(text: string): { code: string; name: string; confidence: number } {
  const samples = {
    en: ['the', 'and', 'is', 'in', 'to', 'of', 'a', 'that'],
    es: ['de', 'la', 'que', 'el', 'en', 'y', 'los', 'se'],
    fr: ['de', 'la', 'et', 'les', 'des', 'le', 'est', 'en'],
    de: ['der', 'die', 'und', 'in', 'zu', 'den', 'das', 'ist'],
    pt: ['de', 'que', 'e', 'o', 'a', 'do', 'da', 'em'],
    it: ['di', 'e', 'il', 'la', 'che', 'in', 'a', 'per'],
  };

  const lower = text.toLowerCase();
  const counts: Record<string, number> = {};
  let totalMatches = 0;
  for (const [code, words] of Object.entries(samples)) {
    let c = 0;
    for (const w of words) {
      const regex = new RegExp(`\\b${w}\\b`, 'g');
      const matches = lower.match(regex);
      if (matches) c += matches.length;
    }
    counts[code] = c;
    totalMatches += c;
  }

  let best = 'en';
  let bestCount = 0;
  for (const [k, v] of Object.entries(counts)) {
    if (v > bestCount) {
      best = k;
      bestCount = v;
    }
  }

  const confidence = totalMatches ? bestCount / totalMatches : 0;
  const names: Record<string, string> = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian' };
  return { code: best, name: names[best] || best, confidence };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { documentId, count = 10, startPage, endPage } = await req.json();
    console.log('Generating quiz for document:', documentId, 'count:', count, 'pages:', startPage, '-', endPage);
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('No authorization header');
    const token = authHeader.replace('Bearer ', '');

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError || !user) throw new Error('User not authenticated');

    const { data: document, error: docError } = await supabaseClient
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .maybeSingle();

    if (docError) throw docError;
    if (!document) throw new Error('Document not found');

    // Try DB flashcards first (existing validated flashcards)
    const { data: existingCards, error: cardsError } = await supabaseClient
      .from('flashcards')
      .select('*')
      .eq('document_id', documentId)
      .eq('user_id', user.id);

    if (cardsError) throw cardsError;
    const validatedCards = Array.isArray(existingCards) ? existingCards : [];
    console.log('Found validated flashcards count:', validatedCards.length);

    function buildQuizFromFlashcards(cards: any[], requestedCount: number) {
      const questions: any[] = [];
      const pool = shuffle([...cards]);
      const maxQuestions = Math.min(requestedCount, pool.length);
      for (let i = 0, added = 0; i < pool.length && added < maxQuestions; i++) {
        const card = pool[i];
        const correct = card.answer;
        const otherAnswers = pool.filter((c) => c.id !== card.id).map((c) => c.answer);
        shuffle(otherAnswers);
        const options = [correct, ...otherAnswers.slice(0, 3)];
        if (options.length < 2) continue;
        while (options.length < 4) {
          const alt = (correct.length > 10) ? correct.slice(0, Math.max(5, Math.floor(correct.length * 0.6))) + '...' : correct + ' (alt)';
          if (!options.includes(alt)) options.push(alt);
          else break;
        }
        const finalOptions = shuffle(options.slice(0, 4));
        const correctIndex = finalOptions.findIndex((o) => o === correct);
        if (correctIndex === -1) continue;
        questions.push({
          question: card.question,
          options: finalOptions,
          correctIndex,
          explanation: '',
        });
        added++;
      }
      return questions;
    }

    if (validatedCards.length >= 4) {
      const questions = buildQuizFromFlashcards(validatedCards, count);
      if (questions.length > 0) {
        const title = `Quiz: ${document.title}`;
        const { data: quiz, error: insertError } = await supabaseClient
          .from('quizzes')
          .insert({
            user_id: user.id,
            document_id: documentId,
            title,
            questions,
          })
          .select()
          .maybeSingle();
        if (insertError) throw insertError;
        return new Response(JSON.stringify({ success: true, quiz }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // Fallback: use document content and relevance-based chunking to prepare prompt
    let content = document.content || '';
    if (!content || content.length < 100) {
      const { data: fileData, error: fileError } = await supabaseClient
        .storage
        .from('documents')
        .download(document.file_path);
      if (fileError) throw fileError;
      try {
        content = await fileData.text();
      } catch {
        const buf = new Uint8Array(await fileData.arrayBuffer());
        content = new TextDecoder('latin1').decode(buf);
      }
    }

    if (!content || content.length < 100) {
      throw new Error('Document content is unreadable for quiz generation. Ensure the document has selectable text or enable OCR.');
    }

    // Relevance chunking
    const CHUNK_SIZE = 2200;
    const OVERLAP = 300;
    const MAX_CONTENT_SIZE = 30000;
    const allChunks = chunkTextByChars(content, CHUNK_SIZE, OVERLAP);
    const contentForKeywords = (startPage || endPage) ? (() => {
      const CHARS_PER_PAGE = 3000;
      const totalEstimatedPages = Math.ceil(content.length / CHARS_PER_PAGE);
      const start = Math.max(0, ((startPage || 1) - 1) * CHARS_PER_PAGE);
      const end = Math.min(content.length, (endPage || totalEstimatedPages) * CHARS_PER_PAGE);
      return content.substring(start, end);
    })() : content;
    const topKeywords = getTopKeywords(contentForKeywords, 60);
    let scored = scoreChunksByKeywords(allChunks, topKeywords as string[]);
    const totalScore = scored.reduce((s, c) => s + (c.score || 0), 0);
    let selectedChunks: Chunk[] = [];
    if (totalScore === 0) {
      const chunkSize = 2000;
      const numChunks = Math.floor(MAX_CONTENT_SIZE / chunkSize) || 1;
      const step = Math.floor(content.length / numChunks);
      const fallbackChunks: Chunk[] = [];
      for (let i = 0; i < numChunks; i++) {
        const s = i * step;
        fallbackChunks.push({ id: `f${i}`, text: content.substring(s, s + chunkSize), start: s, end: s + chunkSize });
      }
      selectedChunks = fallbackChunks;
    } else {
      selectedChunks = selectTopChunks(scored, MAX_CONTENT_SIZE);
    }

    const sampledContent = selectedChunks.map(c => c.text).join('\n\n');

    // Now call AI to generate quizzes (similar to prior implementation), enforce detected language
    const detectedLanguage = detectLanguageByStopwords(content);
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    async function callAIGenerateQuiz(promptContent: string) {
      const body = {
        model: 'google/gemini-2.5-flash',
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 2000,
        messages: [
          {
            role: 'system',
            content: `You are creating ${count} multiple-choice quiz questions (4 options each) about the educational content provided.

RULES:
1. Create questions ONLY about facts, concepts, definitions, and information IN the provided text.
2. Each question must have exactly 4 options and one correct index (0-3).
3. Options should be plausible distractors but NOT correct.
4. Questions, options, and explanations must be in the SAME language as the source text.
5. Use only information present in the SOURCE. If unsure, omit the question.
REPLY IN: ${detectedLanguage.name}`
          },
          {
            role: 'user',
            content: `SOURCE:\n\n${promptContent}`
          }
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'create_quiz',
            description: 'Create a quiz with multiple choice questions',
            parameters: {
              type: 'object',
              properties: {
                questions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      question: { type: 'string' },
                      options: { type: 'array', items: { type: 'string' } },
                      correctIndex: { type: 'number' },
                      explanation: { type: 'string' }
                    },
                    required: ['question', 'options', 'correctIndex', 'explanation']
                  },
                  minItems: 1
                }
              },
              required: ['questions']
            }
          }
        }],
        tool_choice: { type: 'function', function: { name: 'create_quiz' } }
      };

      const resp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`AI Gateway error: ${resp.status} ${errText}`);
      }

      const aiData = await resp.json();
      const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
      if (!toolCall) throw new Error('AI did not return expected format for quiz');
      const quizData = JSON.parse(toolCall.function.arguments);
      const questions = quizData.questions || [];
      if (!Array.isArray(questions) || questions.length === 0) throw new Error('AI failed to generate quiz questions.');
      return questions;
    }

    let aiQuestions = await callAIGenerateQuiz(sampledContent);

    function validateQuizItems(items: any[], sourceText: string) {
      const validated: any[] = [];
      for (const it of items) {
        const correct = it.options?.[it.correctIndex];
        const qOk = supportedBySource(it.question || '', sourceText);
        const aOk = supportedBySource(correct || '', sourceText);
        if (qOk || aOk) validated.push(it);
      }
      return validated;
    }

    let validatedItems = validateQuizItems(aiQuestions, content);
    if (validatedItems.length < Math.min(3, count)) {
      aiQuestions = await callAIGenerateQuiz(sampledContent);
      validatedItems = validateQuizItems(aiQuestions, content);
    }

    if (validatedItems.length === 0) {
      throw new Error('Could not generate quiz questions supported by document. Try generating flashcards first or ensure the document contains selectable text.');
    }

    const finalQuestions = validatedItems.slice(0, count);
    const title = `Quiz: ${document.title}`;
    const { data: quiz, error: insertQuizError } = await supabaseClient
      .from('quizzes')
      .insert({
        user_id: user.id,
        document_id: documentId,
        title,
        questions: finalQuestions,
      })
      .select()
      .maybeSingle();

    if (insertQuizError) throw insertQuizError;
    return new Response(JSON.stringify({ success: true, quiz }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('Error generating quiz:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
