// supabase/functions/generate-quiz/index.ts
// Improved distractor generation: prefer DB answers + document sentences; AI fallback only if necessary.
// Validates distractors so they're plausible, incorrect, and not strongly supported by the source.

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Small helpers (tokenize, jaccard, support scoring, etc.)
function tokenizeWords(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function computeJaccard(a: string, b: string): number {
  const sa = new Set(tokenizeWords(a));
  const sb = new Set(tokenizeWords(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  const inter = [...sa].filter(x => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

function wordCount(s = '') { return s.trim().split(/\s+/).filter(Boolean).length; }

// Reuse a simple support score: overlap ratio of answer tokens with source tokens (0..1)
function computeSupportScoreOfText(snippet: string, source: string): number {
  const sTokens = new Set(tokenizeWords(source));
  const tokens = tokenizeWords(snippet).filter(t => t.length >= 3);
  if (!tokens.length) return 0;
  let matches = 0;
  for (const t of tokens) if (sTokens.has(t)) matches++;
  return tokens.length ? (matches / tokens.length) : 0;
}

// Extract short sentence-like candidates from text chunks
function extractSentences(text: string): string[] {
  if (!text) return [];
  // split by sentence punctuation, keep phrases up to some length
  const parts = text.split(/(?<=[.?!])\s+/).map(s => s.trim()).filter(Boolean);
  const sentences: string[] = [];
  for (const p of parts) {
    // skip very short or extremely long
    const wc = wordCount(p);
    if (wc < 3 || wc > 50) continue;
    sentences.push(p);
  }
  return sentences;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Validate candidate distractor relative to correct answer and source
function isValidDistractor(candidate: string, correctAnswer: string, source: string): boolean {
  if (!candidate) return false;
  const cand = candidate.trim();
  if (!cand) return false;
  // avoid identical or trivially similar strings
  if (cand.toLowerCase() === (correctAnswer || '').toLowerCase()) return false;
  const j = computeJaccard(cand, correctAnswer);
  if (j >= 0.85) return false; // almost identical
  // candidate should not be strongly supported by source (otherwise might be correct)
  const candSupport = computeSupportScoreOfText(cand, source);
  const correctSupport = computeSupportScoreOfText(correctAnswer, source);
  // If candidate is too strongly supported (>= correctSupport - 0.1) then it's risky
  if (candSupport >= Math.max(0.5, correctSupport - 0.15)) return false;
  // Accept candidate if it has some lexical overlap (plausible) or derived from same domain
  const sim = computeJaccard(cand, correctAnswer);
  if (sim >= 0.15 && sim <= 0.75) return true;
  // allow a candidate with moderate support but low similarity (e.g., different phrasing)
  if (candSupport > 0 && sim < 0.15) return true;
  return false;
}

// Choose best distractors from candidate list
function pickBestDistractors(correctAnswer: string, candidates: string[], source: string, needed = 3): string[] {
  const uniq = Array.from(new Set(candidates.map(s => (s || '').trim()).filter(Boolean)));
  // score candidates: prefer moderate similarity (not identical) and low support
  const scored = uniq.map(c => {
    const sim = computeJaccard(c, correctAnswer);
    const support = computeSupportScoreOfText(c, source);
    // ranking heuristic: prefer medium sim (0.2-0.6) and low support
    const score = (Math.max(0, 0.6 - Math.abs(sim - 0.35)) * 0.7) + ((1 - support) * 0.3);
    return { c, sim, support, score };
  }).filter(x => isValidDistractor(x.c, correctAnswer, source));
  scored.sort((a,b) => b.score - a.score);
  const chosen = scored.slice(0, needed).map(s => s.c);
  return chosen;
}

// AI fallback: ask model for distractors, with strict constraints; then validate
async function callAIGenerateDistractors(question: string, correctAnswer: string, sourceSnippet: string, num = 3): Promise<string[]> {
  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY') ?? '';
  if (!LOVABLE_API_KEY) return [];
  const prompt = `You are given a question, the correct answer, and a short SOURCE excerpt. Produce ${num} plausible but incorrect multiple-choice distractors (short phrases or sentences). Each distractor must be:
- Not equal to the correct answer.
- Not supported as a correct answer by the SOURCE (do not invent facts).
- Plausible and related to the topic to be tempting.
Return JSON array of strings only.

QUESTION: ${question}
CORRECT_ANSWER: ${correctAnswer}
SOURCE: ${sourceSnippet}`;

  const body = {
    model: 'google/gemini-2.5-flash',
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 600,
    messages: [
      { role: 'system', content: 'Generate plausible incorrect multiple-choice distractors. Output must be a JSON array of strings.' },
      { role: 'user', content: prompt }
    ]
  };

  try {
    const resp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.error('AI gateway error for distractors:', resp.status, await resp.text());
      return [];
    }
    const data = await resp.json();
    // try to find assistant content (may stream; but usually returns direct)
    const toolText = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!toolText) {
      // try to get text directly
      const raw = JSON.stringify(data);
      const match = raw.match(/\[(?:\s*".*?")+\]/s);
      if (match) {
        try { return JSON.parse(match[0]); } catch {}
      }
      return [];
    }
    // parse JSON from toolText if possible
    try {
      const parsed = JSON.parse(toolText);
      if (Array.isArray(parsed)) return parsed.map(String).slice(0, num);
      // if object with field 'distractors'
      if (parsed.distractors && Array.isArray(parsed.distractors)) return parsed.distractors.map(String).slice(0, num);
    } catch (err) {
      // fallback: try to extract JSON array substring
      const arrMatch = toolText.match(/\[(?:[^\]]+)\]/s);
      if (arrMatch) {
        try { const parsed = JSON.parse(arrMatch[0]); if (Array.isArray(parsed)) return parsed.map(String).slice(0, num); } catch {}
      }
    }
    return [];
  } catch (err) {
    console.error('AI distractor call failed:', err);
    return [];
  }
}

// Main server handler
serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const { documentId, count = 10, startPage, endPage } = await req.json();
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('No authorization header');
    const token = authHeader.replace('Bearer ', '');

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: userErr } = await supabaseClient.auth.getUser(token);
    if (userErr || !user) throw new Error('User not authenticated');

    // Get document
    const { data: document, error: docError } = await supabaseClient
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .maybeSingle();
    if (docError) throw docError;
    if (!document) throw new Error('Document not found');

    // Fetch validated flashcards for this document (prefer to build quizzes from them)
    const { data: existingCards, error: cardsError } = await supabaseClient
      .from('flashcards')
      .select('*')
      .eq('document_id', documentId)
      .eq('user_id', user.id);

    if (cardsError) throw cardsError;
    const validatedCards = Array.isArray(existingCards) ? existingCards : [];

    // Download document content - use AI for PDF extraction
    let content = document.content || '';
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');
    
    if (!content || content.length < 100) {
      const { data: fileData, error: fileError } = await supabaseClient
        .storage
        .from('documents')
        .download(document.file_path);
      if (fileError) throw fileError;
      
      const rawBuffer = new Uint8Array(await fileData.arrayBuffer());
      const pdfMagic = String.fromCharCode(...rawBuffer.slice(0, 5));
      const isPDF = pdfMagic === '%PDF-';
      
      if (isPDF) {
        console.info('PDF detected, using AI for text extraction. Size:', rawBuffer.length);
        const pdfBase64 = btoa(String.fromCharCode(...rawBuffer));
        
        const extractResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'google/gemini-2.5-flash',
            messages: [
              { 
                role: 'user', 
                content: [
                  { type: 'text', text: 'Extract ALL the text content from this PDF document. Return ONLY the extracted text, preserving the structure and formatting. Do not add any commentary or explanations. Just output the raw text content from the document.' },
                  { type: 'file', file: { filename: 'document.pdf', file_data: `data:application/pdf;base64,${pdfBase64}` } }
                ]
              }
            ],
            max_tokens: 16000,
          }),
        });
        
        if (extractResponse.ok) {
          const extractData = await extractResponse.json();
          content = extractData.choices?.[0]?.message?.content || '';
          console.info('AI extracted text length:', content.length);
        } else {
          console.error('AI extraction failed:', extractResponse.status, await extractResponse.text());
          throw new Error('Could not extract text from PDF for quiz generation.');
        }
      } else {
        content = new TextDecoder('utf-8').decode(rawBuffer);
      }
    }

    if (!content || content.length < 100) {
      throw new Error('Document content unreadable for quiz generation.');
    }

    // Prepare sentences from content to use as candidate distractors
    const rawSentences = extractSentences(content);
    // Shuffle to get variety
    shuffle(rawSentences);

    // Helper builds MCQ from a flashcard, tries to find 3 distractors using improved flow
    async function buildMCQFromCard(card: any, otherAnswers: string[], sourceText: string): Promise<{ question: string; options: string[]; correctIndex: number; explanation: string } | null> {
      const question = card.question;
      const correct = card.answer;
      const candidates: string[] = [];

      // 1) Use other flashcards' answers as candidates first (excluding identical)
      for (const a of otherAnswers) {
        if (!a) continue;
        if (a.trim().toLowerCase() === (correct || '').trim().toLowerCase()) continue;
        candidates.push(a.trim());
      }

      // 2) Add sentence candidates from document (short ones)
      for (const s of rawSentences) {
        if (s.length < 20) continue;
        // skip if contains correct answer verbatim
        if (correct && s.toLowerCase().includes(correct.toLowerCase().slice(0, Math.min(30, correct.length)))) continue;
        candidates.push(s);
      }

      // pick best distractors from candidates
      const distractors = pickBestDistractors(correct, candidates, sourceText, 3);

      // If not enough distractors and AI fallback allowed, call AI
      if (distractors.length < 3) {
        // build a short source snippet (use question-related chunks if available; here we use whole content truncated)
        const snippet = sourceText.slice(0, 4000);
        // Try AI fallback
        // Note: this may incur API cost; this fallback only runs when local candidates insufficient
        // You can disable by removing LOVABLE_API_KEY or guard via env var.
        // We will still validate AI distractors with the same rules.
        // Await AI call and then validate
        // (Call is async; here synchronous flow is fine)
        // eslint-disable-next-line no-await-in-loop
        const aiDistractors = await callAIGenerateDistractors(question, correct, snippet, 3);
        for (const d of aiDistractors) {
          if (isValidDistractor(d, correct, sourceText)) distractors.push(d);
          if (distractors.length >= 3) break;
        }
      }

      if (distractors.length < 3) {
        // Not enough validated distractors; skip this card to avoid low-quality MCQ
        return null;
      }

      // Build options and shuffle
      const options = shuffle([correct, ...distractors.slice(0,3)]);
      const correctIndex = options.findIndex(o => o === correct);
      const explanation = card.page_from && card.page_to ? `See pages ${card.page_from}${card.page_to !== card.page_from ? `-${card.page_to}` : ''}` : '';
      return { question, options, correctIndex, explanation };
    }

    // If we have >=4 validated flashcards, try to build quiz from them (prefer DB)
    if (validatedCards.length >= 4) {
      const pool = validatedCards.slice(); // copy
      shuffle(pool);
      const questions: any[] = [];
      for (const card of pool) {
        // assemble other answers pool from flashcards (excluding this one)
        const otherAnswers = validatedCards.filter(c => c.id !== card.id).map(c => c.answer);
        const mcq = buildMCQFromCard(card, otherAnswers, content);
        if (mcq) questions.push(mcq);
        if (questions.length >= count) break;
      }

      // If we could build at least 1 question, insert quiz
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
      // else fall through to AI generation path
    }

    // Fallback to AI-based quiz generation (existing fallback flow)
    // We'll reuse document sampling + chunking approach similar to flashcards function to prepare prompt (kept simple here)
    // Simple sample of content
    const sample = content.length <= 30000 ? content : (() => {
      const chunkSize = 2000;
      const numChunks = Math.floor(30000 / chunkSize) || 1;
      const step = Math.floor(content.length / numChunks);
      const chunks = [];
      for (let i = 0; i < numChunks; i++) {
        const s = i * step;
        chunks.push(content.substring(s, s + chunkSize));
      }
      return chunks.join('\n\n');
    })();

    // LOVABLE_API_KEY already declared above

    // AI-based quiz generation (same as previous); keep validation of items using the same validators above
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
6. Output should be a function call to create_quiz with JSON: { questions: [ {question, options, correctIndex, explanation}, ... ] }`
          },
          { role: 'user', content: `SOURCE:\n\n${promptContent}` }
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
                    required: ['question','options','correctIndex','explanation']
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
        headers: { 'Authorization': `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const t = await resp.text();
        console.error('AI gateway error:', resp.status, t);
        throw new Error(`AI Gateway error: ${resp.status}`);
      }
      const data = await resp.json();
      const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
      if (!toolCall) throw new Error('AI did not return expected quiz format');
      let quizData;
      try { quizData = JSON.parse(toolCall.function.arguments); } catch (err) { console.error('Parse quiz args failed:', err); throw new Error('Failed to parse quiz data from AI'); }
      const questions = quizData.questions || [];
      if (!Array.isArray(questions) || questions.length === 0) throw new Error('AI failed to generate quiz questions.');
      return questions;
    }

    // Generate and validate AI quiz items, then persist
    let aiQuestions = await callAIGenerateQuiz(sample);
    function validateQuizItems(items: any[], sourceText: string) {
      const validated: any[] = [];
      for (const it of items) {
        const correct = it.options?.[it.correctIndex];
        // Check if question or answer contains keywords from source
        const questionWords = (it.question || '').toLowerCase().split(/\s+/).filter((w: string) => w.length > 4);
        const answerWords = (correct || '').toLowerCase().split(/\s+/).filter((w: string) => w.length > 4);
        const sourceTextLower = sourceText.toLowerCase();
        const qOk = questionWords.some((w: string) => sourceTextLower.includes(w));
        const aOk = answerWords.some((w: string) => sourceTextLower.includes(w));
        if (qOk || aOk) validated.push(it);
      }
      return validated;
    }

    let validatedItems = validateQuizItems(aiQuestions, content);
    if (validatedItems.length < Math.min(3, count)) {
      aiQuestions = await callAIGenerateQuiz(sample);
      validatedItems = validateQuizItems(aiQuestions, content);
    }

    if (validatedItems.length === 0) {
      throw new Error('Could not generate quiz questions supported by document. Try generating flashcards first or ensure the document contains selectable text.');
    }

    const finalQuestions = validatedItems.slice(0, count);
    const title = `Quiz: ${document.title}`;
    const { data: quiz, error: insertQuizError } = await supabaseClient
      .from('quizzes')
      .insert({ user_id: user.id, document_id: documentId, title, questions: finalQuestions })
      .select()
      .maybeSingle();
    if (insertQuizError) throw insertQuizError;

    return new Response(JSON.stringify({ success: true, quiz }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('Error generating quiz:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return new Response(JSON.stringify({ error: errorMessage }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
