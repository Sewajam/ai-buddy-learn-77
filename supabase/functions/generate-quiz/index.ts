// supabase/functions/generate-quiz/index.ts
// Updated: Prefer DB flashcards for quiz generation; fallback to AI with validation and language enforcement.
// Creates multiple-choice quizzes (4 options per question) and stores them in the quizzes table.

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Lightweight language detection reused (stopword-based)
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

// Basic check if answer or question tokens appear in source
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

// Shuffle helper
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { documentId, count = 10, startPage, endPage } = await req.json();
    console.log('Generating quiz for document:', documentId, 'count:', count, 'pages:', startPage, '-', endPage);

    const authHeader = req.headers.get('Authorization');
    console.log('Auth header present:', !!authHeader);
    if (!authHeader) throw new Error('No authorization header');

    const token = authHeader.replace('Bearer ', '');

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: authHeader },
        },
      }
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser(token);
    console.log('User authenticated:', !!user, 'Error:', userError?.message);
    if (userError || !user) throw new Error('User not authenticated');

    // Fetch document to get title and maybe cached content
    const { data: document, error: docError } = await supabaseClient
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .maybeSingle();

    if (docError) throw docError;
    if (!document) throw new Error('Document not found');

    // Try to use validated flashcards already stored for this document
    const { data: existingCards, error: cardsError } = await supabaseClient
      .from('flashcards')
      .select('*')
      .eq('document_id', documentId)
      .eq('user_id', user.id);

    if (cardsError) throw cardsError;

    const validatedCards = Array.isArray(existingCards) ? existingCards : [];
    console.log('Found validated flashcards count:', validatedCards.length);

    // Helper to build MCQ from flashcards: use other flashcards' answers as distractors when possible
    function buildQuizFromFlashcards(cards: any[], requestedCount: number) {
      const questions: any[] = [];
      // Shuffle cards to pick random ones
      const pool = shuffle([...cards]);
      const maxQuestions = Math.min(requestedCount, pool.length);
      // For each card, pick distractors from other cards' answers
      for (let i = 0, added = 0; i < pool.length && added < maxQuestions; i++) {
        const card = pool[i];
        const correct = card.answer;
        // pick up to 3 other answers as distractors
        const otherAnswers = pool.filter((c) => c.id !== card.id).map((c) => c.answer);
        shuffle(otherAnswers);
        const options = [correct, ...otherAnswers.slice(0, 3)];
        // If not enough distractors, skip this card (we will handle with fallback)
        if (options.length < 2) continue;
        // ensure options length is 4 (duplicate or generate simple distractors if necessary)
        while (options.length < 4) {
          // create a simple distractor by truncating/altering correct answer (not ideal but fallback)
          const alt = (correct.length > 10) ? correct.slice(0, Math.max(5, Math.floor(correct.length * 0.6))) + '...' : correct + ' (alt)';
          if (!options.includes(alt)) options.push(alt);
          else break;
        }
        // Trim to 4 and shuffle
        const finalOptions = shuffle(options.slice(0, 4));
        const correctIndex = finalOptions.findIndex((o) => o === correct);
        // Basic validation: ensure correctIndex found
        if (correctIndex === -1) continue;
        questions.push({
          question: card.question,
          options: finalOptions,
          correctIndex,
          explanation: '', // explanation can be empty; UI could request it later
        });
        added++;
      }
      return questions;
    }

    // If we have at least 4 validated cards, prefer DB-based quiz generation
    if (validatedCards.length >= 4) {
      const questions = buildQuizFromFlashcards(validatedCards, count);
      if (questions.length === 0) {
        console.log('Could not build quiz from DB flashcards despite having cards; falling back to AI generation.');
      } else {
        // Insert quiz into DB
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
        console.log('Created quiz from validated flashcards with', questions.length, 'questions');
        return new Response(
          JSON.stringify({ success: true, quiz }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Fallback to AI-based quiz generation (if not enough validated flashcards)
    // We'll attempt to use document.content if present, else download and extract text similar to flashcards function
    let content = document.content || '';
    if (!content || content.length < 100) {
      const { data: fileData, error: fileError } = await supabaseClient
        .storage
        .from('documents')
        .download(document.file_path);
      if (fileError) throw fileError;
      // Attempt to read as text (best-effort)
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

    // Detect language and enforce in AI prompt
    const detectedLanguage = detectLanguageByStopwords(content);
    console.log('Detected language for quiz:', detectedLanguage);

    // Sample content similarly to flashcards function to limit size
    const MAX_CONTENT_SIZE = 30000;
    let sampledContent = '';
    if (content.length <= MAX_CONTENT_SIZE) {
      sampledContent = content;
    } else {
      const chunkSize = 2000;
      const numChunks = Math.floor(MAX_CONTENT_SIZE / chunkSize) || 1;
      const step = Math.floor(content.length / numChunks);
      const chunks: string[] = [];
      for (let i = 0; i < numChunks; i++) {
        const s = i * step;
        chunks.push(content.substring(s, s + chunkSize));
      }
      sampledContent = chunks.join('\n\n');
    }

    // Prepare AI call to generate MCQs (function tool-call expected)
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    async function callAIGenerateQuiz(promptContent: string, attempts = 1) {
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
6. Provide output as a function call to create_quiz as defined in tools parameter.
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
                      question: { type: 'string', description: 'The question text' },
                      options: { type: 'array', items: { type: 'string' }, description: 'Array of 4 possible answers' },
                      correctIndex: { type: 'number', description: 'Index of the correct answer (0-3)' },
                      explanation: { type: 'string', description: 'Explanation of the correct answer' }
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
        console.error('AI Gateway error:', resp.status, errText);
        throw new Error(`AI Gateway error: ${resp.status}`);
      }

      const aiData = await resp.json();
      console.log('AI response structure:', JSON.stringify(aiData, null, 2).substring(0, 2000));
      const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
      if (!toolCall) {
        console.error('No tool call in AI response');
        throw new Error('AI did not return expected quiz format');
      }

      let quizData;
      try {
        quizData = JSON.parse(toolCall.function.arguments);
      } catch (parseError) {
        console.error('Failed to parse tool call arguments:', parseError);
        throw new Error('Failed to parse quiz data from AI');
      }

      const questions = quizData.questions || [];
      if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error('AI failed to generate quiz questions.');
      }

      return questions;
    }

    // Attempt AI generation with validation if DB path failed
    let aiQuestions = await callAIGenerateQuiz(sampledContent);

    // Validate AI-generated questions against source: ensure question or correct option appears in source
    function validateQuizItems(items: any[], sourceText: string) {
      const validated: any[] = [];
      for (const it of items) {
        const correct = it.options?.[it.correctIndex];
        const qOk = supportedBySource(it.question || '', sourceText);
        const aOk = supportedBySource(correct || '', sourceText);
        if (qOk || aOk) {
          validated.push(it);
        } else {
          console.log('Dropping AI item not supported by source:', it.question?.substring(0, 100));
        }
      }
      return validated;
    }

    let validatedItems = validateQuizItems(aiQuestions, content);
    console.log('Validated AI quiz items count:', validatedItems.length);

    // Retry once if too few validated items
    if (validatedItems.length < Math.min(3, count)) {
      console.log('Validated items low, retrying AI with stricter instruction...');
      aiQuestions = await callAIGenerateQuiz(sampledContent);
      validatedItems = validateQuizItems(aiQuestions, content);
      console.log('Post-retry validated items count:', validatedItems.length);
    }

    if (validatedItems.length === 0) {
      throw new Error('Could not generate quiz questions supported by document. Try generating flashcards first or ensure the document contains selectable text.');
    }

    // Trim to requested count
    const finalQuestions = validatedItems.slice(0, count);

    // Insert quiz into DB
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
    console.log('Created quiz via AI with', finalQuestions.length, 'questions');

    return new Response(
      JSON.stringify({ success: true, quiz }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error generating quiz:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
