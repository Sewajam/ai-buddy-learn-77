// supabase/functions/generate-flashcards/index.ts
// Updated: adds explicit difficulty mapping, few-shot examples per difficulty,
// request-time distribution control, and post-generation enforcement/validation.
// Builds on the previous robust extractor, chunking, language enforcement,
// validation, dedupe and page-range mapping logic.

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// -------------------- Config / Difficulty rules --------------------
const CHARS_PER_PAGE_ESTIMATE = 3000;
const CHUNK_SIZE = 2200;
const CHUNK_OVERLAP = 300;
const MAX_CONTENT_SIZE = 30000; // characters
const DEDUPE_JACCARD_THRESHOLD = 0.7;
const SUPPORT_RETRY_THRESHOLD = 0.6;
const MIN_ACCEPT_SUPPORT_RATE = 0.5;

// Difficulty answer length rules (by word count)
const DIFFICULTY_RULES = {
  easy: { minWords: 1, maxWords: 12, maxSentences: 1 },
  medium: { minWords: 13, maxWords: 40, maxSentences: 2 },
  hard: { minWords: 41, maxWords: 250, maxSentences: 6 },
};

// For mixed distribution default ratios (easy, medium, hard)
const MIXED_DISTRIBUTION = { easy: 0.4, medium: 0.4, hard: 0.2 };

// -------------------- Helpers (extraction, tokenization, chunking, scoring, OCR) --------------------
// These functions are the same robust helpers used previously: extractTextFromPDF, isBinaryContentFromBuffer,
// cleanTextContent, callExternalOCR, tokenizeWords, getTopKeywords, splitIntoPages, chunkPagesToChunks,
// scoreChunksByKeywords, selectTopChunksByChars, detectLanguageByStopwords, supportedBySource,
// computeJaccard, computeSupportScore, dedupeCards.
//
// For brevity in this display I include full implementations; keep them consistent with earlier replacements.

function collapseWhitespace(s: string) {
  return s.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

function extractTextFromPDF(binaryContent: string): string {
  const textParts: string[] = [];
  const tjMatches = binaryContent.match(/\(([^)]+)\)\s*Tj/g);
  if (tjMatches) {
    for (const match of tjMatches) {
      const text = match.replace(/\(([^)]+)\)\s*Tj/, '$1');
      if (text && /^[\x20-\x7E\s]+$/.test(text)) textParts.push(text);
    }
  }
  const asciiMatches = binaryContent.match(/[\x20-\x7E]{20,}/g);
  if (asciiMatches) {
    for (const match of asciiMatches) {
      if (!match.includes('stream') &&
          !match.includes('endobj') &&
          !match.includes('/Type') &&
          !match.includes('/Font') &&
          !match.includes('<<') &&
          !match.includes('>>')) {
        textParts.push(match);
      }
    }
  }
  return collapseWhitespace(textParts.join(' '));
}

function isBinaryContentFromBuffer(buf: Uint8Array): boolean {
  const pdfMagic = String.fromCharCode(...buf.slice(0, 5));
  if (pdfMagic === '%PDF-') return true;
  const sampleLen = Math.min(buf.length, 1000);
  let nonPrintable = 0;
  for (let i = 0; i < sampleLen; i++) {
    const code = buf[i];
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code > 126) nonPrintable++;
  }
  return (nonPrintable / Math.max(1, sampleLen)) > 0.1;
}

function cleanTextContent(content: string): string {
  let cleaned = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ');
  cleaned = cleaned.replace(/\b[\w]{1,2}\b/g, ' ').replace(/\s+/g, ' ');
  return cleaned.trim();
}

async function callExternalOCR(apiUrl: string, apiKey: string, fileBase64: string): Promise<string> {
  try {
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ file: fileBase64 }),
    });
    if (!resp.ok) {
      console.error('OCR API error:', resp.status, await resp.text());
      return '';
    }
    const j = await resp.json();
    return (j.text || j.data?.text || '').trim();
  } catch (err) {
    console.error('OCR call failed:', err);
    return '';
  }
}

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

function getTopKeywords(text: string, topK = 60) {
  const tokens = tokenizeWords(text);
  const freq: Record<string, number> = {};
  for (const t of tokens) {
    if (t.length <= 2) continue;
    if (STOPWORDS.has(t)) continue;
    freq[t] = (freq[t] || 0) + 1;
  }
  return Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0, topK).map(e=>e[0]);
}

function splitIntoPages(content: string): string[] {
  if (!content) return [];
  let pages = content.split(/\f/).map(s=>s.trim()).filter(Boolean);
  if (pages.length > 1) return pages;
  pages = content.split(/\n(?=Page\s+\d+\b)/).map(s=>s.trim()).filter(Boolean);
  if (pages.length > 1) return pages;
  const total = content.length;
  const numPages = Math.max(1, Math.ceil(total / CHARS_PER_PAGE_ESTIMATE));
  const res: string[] = [];
  for (let i = 0; i < numPages; i++) {
    const start = i * CHARS_PER_PAGE_ESTIMATE;
    const end = Math.min(total, (i+1) * CHARS_PER_PAGE_ESTIMATE);
    res.push(content.slice(start, end).trim());
  }
  return res.filter(Boolean);
}

type Chunk = { id: string; text: string; page_from: number; page_to: number; start: number; end: number; score?: number };

function chunkPagesToChunks(pages: string[], chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): Chunk[] {
  const chunks: Chunk[] = [];
  let id = 0;
  let globalOffset = 0;
  for (let p = 0; p < pages.length; p++) {
    const pageText = pages[p] || '';
    let start = 0;
    while (start < pageText.length) {
      const end = Math.min(start + chunkSize, pageText.length);
      const slice = pageText.slice(start, end).trim();
      if (slice) {
        chunks.push({
          id: `c${id++}`,
          text: slice,
          page_from: p + 1,
          page_to: p + 1,
          start: globalOffset + start,
          end: globalOffset + end,
        });
      }
      start = end - overlap;
      if (start < 0) start = 0;
      if (end === pageText.length) break;
    }
    globalOffset += pageText.length;
  }
  return chunks;
}

function scoreChunksByKeywords(chunks: Chunk[], keywords: string[]): Chunk[] {
  if (!keywords || keywords.length === 0) return chunks;
  const kw = new Set(keywords);
  for (const c of chunks) {
    const tokens = tokenizeWords(c.text);
    let score = 0;
    for (const t of tokens) if (kw.has(t)) score++;
    c.score = score;
  }
  return chunks.sort((a,b)=> (b.score||0) - (a.score||0));
}

function selectTopChunksByChars(chunks: Chunk[], maxChars = MAX_CONTENT_SIZE): Chunk[] {
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

function detectLanguageByStopwords(text: string): { code: string; name: string; confidence: number } {
  const samples: Record<string,string[]> = {
    en: ['the','and','is','in','to','of','a','that'],
    es: ['de','la','que','el','en','y','los','se'],
    fr: ['de','la','et','les','des','le','est','en'],
    de: ['der','die','und','in','zu','den','das','ist'],
    pt: ['de','que','e','o','a','do','da','em'],
    it: ['di','e','il','la','che','in','a','per'],
  };
  const lower = text.toLowerCase();
  const counts: Record<string, number> = {};
  let total = 0;
  for (const [k, words] of Object.entries(samples)) {
    let c = 0;
    for (const w of words) {
      const m = lower.match(new RegExp(`\\b${w}\\b`, 'g'));
      if (m) c += m.length;
    }
    counts[k] = c;
    total += c;
  }
  let best = 'en'; let bestCount = 0;
  for (const [k,v] of Object.entries(counts)) {
    if (v > bestCount) { best = k; bestCount = v; }
  }
  const confidence = total ? bestCount / total : 0;
  const names: Record<string,string> = { en:'English', es:'Spanish', fr:'French', de:'German', pt:'Portuguese', it:'Italian' };
  return { code: best, name: names[best] || best, confidence };
}

function supportedBySource(needle: string, haystack: string): boolean {
  if (!needle || !haystack) return false;
  const tokens = tokenizeWords(needle).filter(t => t.length >= 3);
  if (tokens.length === 0) return false;
  const hs = haystack.toLowerCase();
  for (const t of tokens) if (hs.includes(t)) return true;
  return false;
}

function computeJaccard(a: string, b: string): number {
  const sa = new Set(tokenizeWords(a));
  const sb = new Set(tokenizeWords(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  const inter = [...sa].filter(x => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

function computeSupportScore(card: {question:string, answer:string}, source: string): number {
  const qTokens = tokenizeWords(card.question||'').filter(t=>t.length>=3);
  const aTokens = tokenizeWords(card.answer||'').filter(t=>t.length>=3);
  const sourceSet = new Set(tokenizeWords(source));
  function overlapRatio(tokens:string[]) {
    if (tokens.length===0) return 0;
    let matches = 0;
    for (const t of tokens) if (sourceSet.has(t)) matches++;
    return tokens.length ? matches / tokens.length : 0;
  }
  const qScore = overlapRatio(qTokens);
  const aScore = overlapRatio(aTokens);
  return Math.min(1, (0.4*qScore) + (0.6*aScore));
}

function dedupeCards(cards: any[], threshold = DEDUPE_JACCARD_THRESHOLD) {
  const unique: any[] = [];
  for (const c of cards) {
    const combined = `${c.question} ||| ${c.answer}`;
    let isDup = false;
    for (const u of unique) {
      const uCombined = `${u.question} ||| ${u.answer}`;
      const sim = computeJaccard(combined, uCombined);
      if (sim >= threshold) {
        isDup = true;
        if ((c.confidence || 0) > (u.confidence || 0)) {
          u.question = c.question;
          u.answer = c.answer;
          u.difficulty = c.difficulty || u.difficulty;
          u.confidence = c.confidence;
        }
        break;
      }
    }
    if (!isDup) unique.push(c);
  }
  return unique;
}

// -------------------- Difficulty mapping helpers --------------------

function wordCount(s: string) {
  if (!s) return 0;
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function sentenceCount(s: string) {
  if (!s) return 0;
  // crude sentence splitter by punctuation
  return s.split(/[.?!]+/).map(p=>p.trim()).filter(Boolean).length;
}

// Classify an answer into a difficulty bucket using DIFFICULTY_RULES
function classifyAnswerDifficulty(answer: string) : 'easy'|'medium'|'hard' {
  const wc = wordCount(answer);
  const sc = sentenceCount(answer);
  if (wc <= DIFFICULTY_RULES.easy.maxWords && sc <= DIFFICULTY_RULES.easy.maxSentences) return 'easy';
  if (wc <= DIFFICULTY_RULES.medium.maxWords && sc <= DIFFICULTY_RULES.medium.maxSentences) return 'medium';
  return 'hard';
}

// Build desired counts per difficulty given requested difficulty parameter
function desiredCountsForDifficulty(totalCount: number, difficulty: string) {
  if (difficulty === 'mixed') {
    const easy = Math.round(totalCount * MIXED_DISTRIBUTION.easy);
    const medium = Math.round(totalCount * MIXED_DISTRIBUTION.medium);
    let hard = totalCount - easy - medium;
    if (hard < 0) hard = 0;
    // adjust if rounding made sum off
    const sum = easy + medium + hard;
    if (sum !== totalCount) {
      // fix by adjusting medium
      const diff = totalCount - sum;
      return { easy, medium: medium + diff, hard };
    }
    return { easy, medium, hard };
  } else if (difficulty === 'easy' || difficulty === 'medium' || difficulty === 'hard') {
    const obj: any = { easy:0, medium:0, hard:0 };
    obj[difficulty] = totalCount;
    return obj;
  } else {
    // fallback to mixed
    return desiredCountsForDifficulty(totalCount, 'mixed');
  }
}

// Check distribution of generated cards against desired
function distributionStats(cards: any[], desiredCounts: {easy:number, medium:number, hard:number}) {
  const counts = { easy:0, medium:0, hard:0 };
  for (const c of cards) {
    const d = (c.difficulty || classifyAnswerDifficulty(c.answer)).toLowerCase();
    if (d === 'easy' || d === 'medium' || d === 'hard') counts[d]++;
    else counts.medium++;
  }
  return { counts, desiredCounts };
}

// -------------------- Main handler --------------------

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { documentId, count = 10, difficulty = 'mixed', startPage, endPage } = await req.json();

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

    // Extraction (binary-aware) same as before
    let content = document.content || '';
    let usedOcr = false;
    let detectedLanguage = { code: 'und', name: 'Unknown', confidence: 0 };

    if (!content || content.length < 100) {
      const { data: fileData, error: fileError } = await supabaseClient
        .storage
        .from('documents')
        .download(document.file_path);
      if (fileError) throw fileError;

      const rawBuffer = new Uint8Array(await fileData.arrayBuffer());
      const looksBinary = isBinaryContentFromBuffer(rawBuffer);

      if (looksBinary) {
        const rawLatin1 = new TextDecoder('latin1').decode(rawBuffer);
        content = extractTextFromPDF(rawLatin1);
        if (!content || content.length < 100) {
          const OCR_API_URL = Deno.env.get('OCR_API_URL') ?? '';
          const OCR_API_KEY = Deno.env.get('OCR_API_KEY') ?? '';
          if (OCR_API_URL) {
            const b64 = btoa(String.fromCharCode(...rawBuffer));
            const ocrText = await callExternalOCR(OCR_API_URL, OCR_API_KEY, b64);
            if (ocrText && ocrText.length > content.length) {
              usedOcr = true;
              content = ocrText;
            }
          } else {
            throw new Error('Could not extract selectable text from this PDF (likely scanned). Enable OCR or upload a text-based document.');
          }
        }
      } else {
        const rawText = new TextDecoder('utf-8').decode(rawBuffer);
        content = cleanTextContent(rawText);
      }
    }

    if (!content || content.length < 100) {
      throw new Error('Document appears to be empty or unreadable.');
    }

    detectedLanguage = detectLanguageByStopwords(content);

    // Page-aware chunking and selection (as earlier)
    const pages = splitIntoPages(content);
    let pagesToUse = pages;
    if (startPage || endPage) {
      const from = Math.max(1, startPage || 1);
      const to = Math.min(pages.length, endPage || pages.length);
      pagesToUse = pages.slice(from-1, to);
    }

    const allChunks = chunkPagesToChunks(pagesToUse, CHUNK_SIZE, CHUNK_OVERLAP);
    const contentForKeywords = pagesToUse.join(' ');
    const topKeywords = getTopKeywords(contentForKeywords, 60);
    let scoredChunks = scoreChunksByKeywords(allChunks, topKeywords);
    const totalScore = scoredChunks.reduce((s,c)=>s+(c.score||0),0);
    let selectedChunks: Chunk[] = [];
    if (totalScore === 0) {
      const fallbackChunks: Chunk[] = [];
      const flat = pagesToUse.join('\n\n');
      const numChunks = Math.floor(MAX_CONTENT_SIZE / CHUNK_SIZE) || 1;
      const step = Math.floor(flat.length / numChunks);
      for (let i = 0; i < numChunks; i++) {
        const s = i * step;
        const slice = flat.substring(s, s + CHUNK_SIZE);
        fallbackChunks.push({ id:`f${i}`, text: slice, page_from: 1, page_to: pagesToUse.length, start:s, end:s+slice.length });
      }
      selectedChunks = fallbackChunks;
    } else {
      selectedChunks = selectTopChunksByChars(scoredChunks, MAX_CONTENT_SIZE);
    }

    const sampledContentParts: string[] = selectedChunks.map(c => `SOURCE (pages ${c.page_from}${c.page_to && c.page_to !== c.page_from ? `-${c.page_to}` : ''}):\n${c.text}`);
    const sampledContent = sampledContentParts.join('\n\n');

    // Difficulty distribution planning
    const desiredCounts = desiredCountsForDifficulty(count, difficulty);

    // Few-shot examples expanded (2 per difficulty) — kept in English but model is instructed to reply in detectedLanguage
    const fewShotExamples = `
EXAMPLES (format: {"question":"...","answer":"...","difficulty":"easy|medium|hard"}):

Easy examples:
{"question":"What is gravity?","answer":"Gravity is the force that attracts objects with mass toward each other.","difficulty":"easy"}
{"question":"Who developed the theory of relativity?","answer":"Albert Einstein developed the theory of relativity.","difficulty":"easy"}

Medium examples:
{"question":"How does Newton's second law relate force, mass, and acceleration?","answer":"Newton's second law states that force equals mass times acceleration (F = ma), meaning acceleration is proportional to force and inversely proportional to mass.","difficulty":"medium"}
{"question":"Why do cells use ATP in metabolism?","answer":"Cells use ATP because it stores and provides energy for biochemical reactions; ATP hydrolysis releases energy used to drive cellular processes.","difficulty":"medium"}

Hard examples:
{"question":"Explain how the double-slit experiment demonstrates the wave-particle duality of light.","answer":"The double-slit experiment shows that light produces an interference pattern when not observed, indicating wave-like behavior; but when photons are measured at the slits, they behave like particles. This duality implies that quantum objects exhibit both wave and particle properties depending on measurement context.","difficulty":"hard"}
{"question":"Discuss the implications of feedback loops in climate models for long-term climate sensitivity estimates.","answer":"Feedback loops such as ice-albedo and water vapor amplify initial forcings; positive feedbacks increase climate sensitivity, while negative feedbacks moderate responses. Accurate modeling of feedback strengths is essential for reliable long-term sensitivity predictions.","difficulty":"hard"}
`;

    // AI call function — instruct model to produce the exact counts per difficulty
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    async function callGenerateFlashcards(promptContent: string, distribution: {easy:number,medium:number,hard:number}, instructionExtension = '') {
      // build distribution instruction text
      let distText = '';
      if (distribution.easy + distribution.medium + distribution.hard === count) {
        if (difficulty === 'mixed') {
          distText = `Produce ${distribution.easy} easy, ${distribution.medium} medium, and ${distribution.hard} hard flashcards (total ${count}).`;
        } else {
          const only = distribution.easy ? 'easy' : distribution.medium ? 'medium' : 'hard';
          distText = `Produce ${count} ${only} flashcards.`;
        }
      } else {
        distText = `Produce ${count} flashcards with a balanced mix.`;
      }

      const body = {
        model: 'google/gemini-2.5-flash',
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 2000,
        messages: [
          {
            role: 'system',
            content: `You are producing study flashcards formatted as JSON objects with fields: question, answer, difficulty ("easy","medium","hard").

RULES:
1) ${distText}
2) Questions must be directly answerable from the provided SOURCE text.
3) Use the following difficulty rules for answers:
   - easy: concise factual recall, answer 1 sentence, 1–12 words.
   - medium: conceptual questions, answers 1–2 sentences (~13–40 words).
   - hard: analytical or application questions, answers 2–4 sentences (~41–250 words).
4) Output must be a function call to create_flashcards with a JSON payload: { "flashcards": [ { "question": "...", "answer":"...", "difficulty":"easy" }, ... ] }
5) Reply in the same language as the source text (REPLY IN: ${detectedLanguage.name}).
${instructionExtension}
`
          },
          {
            role: 'user',
            content: `SOURCE:\n\n${promptContent}\n\n${fewShotExamples}`
          }
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'create_flashcards',
            description: 'Create study flashcards from the document',
            parameters: {
              type: 'object',
              properties: {
                flashcards: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      question: { type: 'string' },
                      answer: { type: 'string' },
                      difficulty: { type: 'string', enum: ['easy','medium','hard'] }
                    },
                    required: ['question','answer','difficulty']
                  },
                  minItems: 1
                }
              },
              required: ['flashcards']
            }
          }
        }],
        tool_choice: { type: 'function', function: { name: 'create_flashcards' } }
      };

      const r = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!r.ok) {
        const errText = await r.text();
        console.error('AI Gateway error:', r.status, errText);
        throw new Error(`AI Gateway error: ${r.status}`);
      }

      const aiData = await r.json();
      const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
      if (!toolCall) {
        console.error('No tool call found in response');
        throw new Error('No flashcards generated - AI did not return expected format');
      }

      let flashcardsData;
      try {
        flashcardsData = JSON.parse(toolCall.function.arguments);
      } catch (err) {
        console.error('Failed to parse tool call args:', err);
        throw new Error('Failed to parse flashcard data from AI');
      }

      const cards = flashcardsData.flashcards || [];
      if (!Array.isArray(cards) || cards.length === 0) {
        console.error('AI returned no flashcards:', JSON.stringify(flashcardsData));
        throw new Error('AI failed to generate flashcards. Please try again.');
      }
      return cards;
    }

    // Call AI with desired distribution instruction
    const distribution = desiredCountsForDifficulty(count, difficulty);
    let generated = await callGenerateFlashcards(sampledContent, distribution);

    // Validate support and difficulty compliance
    function validateAndClassify(cards: any[], source: string, distribution: {easy:number,medium:number,hard:number}) {
      const validated: any[] = [];
      let supported = 0;
      for (const c of cards) {
        const qOk = supportedBySource(c.question || '', source);
        const aOk = supportedBySource(c.answer || '', source);
        if (qOk || aOk) supported++;
        // Ensure difficulty field exists and is one of easy/medium/hard
        let declared = (c.difficulty || '').toLowerCase();
        if (!['easy','medium','hard'].includes(declared)) {
          declared = classifyAnswerDifficulty(c.answer);
          c.difficulty = declared;
        }
        // Reclassify based on answer length if mismatch
        const classified = classifyAnswerDifficulty(c.answer);
        if (classified !== declared) {
          // prefer classification from content length because AI sometimes mislabels
          c.difficulty = classified;
        }
        // Enforce difficulty rules: if strict requested (not mixed) and mismatched, we'll mark
        validated.push(c);
      }
      const supportRate = cards.length ? (supported / cards.length) : 0;

      // Check distribution match
      const counts = { easy: 0, medium: 0, hard: 0 };
      for (const v of validated) {
        counts[v.difficulty] = (counts[v.difficulty] || 0) + 1;
      }

      return { validated, supportRate, counts };
    }

    let { validated, supportRate, counts } = validateAndClassify(generated, content, distribution);

    // If supportRate low, retry once with stricter instruction
    if (supportRate < SUPPORT_RETRY_THRESHOLD) {
      const stricterInstruction = 'IMPORTANT: Only include cards that are directly supported by the SOURCE. Use EXACT distribution requested and strictly follow the difficulty answer length rules.';
      generated = await callGenerateFlashcards(sampledContent, distribution, `\n${stricterInstruction}`);
      ({ validated, supportRate, counts } = validateAndClassify(generated, content, distribution));
    }

    // Enforce distribution for non-mixed requests: if requested single difficulty but cards not matching,
    // attempt to filter to desired difficulty and, if not enough, fail with helpful error.
    let finalCards = validated;
    if (difficulty !== 'mixed') {
      const desiredCount = distribution[difficulty as keyof typeof distribution];
      const filtered = validated.filter((c:any) => (c.difficulty === difficulty));
      if (filtered.length < desiredCount) {
        // try to fetch more by requesting again strictly for that difficulty
        const stricterInstruction = `Please produce ${desiredCount} ${difficulty} flashcards. Follow the ${difficulty} answer rules exactly.`;
        const regener = await callGenerateFlashcards(sampledContent, distribution, `\n${stricterInstruction}`);
        const { validated: v2, supportRate: sr2 } = validateAndClassify(regener, content, distribution);
        const filtered2 = v2.filter((c:any) => c.difficulty === difficulty);
        if (filtered2.length >= desiredCount) {
          finalCards = filtered2.slice(0, desiredCount);
        } else {
          // fall back to taking whatever validated of that difficulty we have
          finalCards = filtered.concat(filtered2).slice(0, Math.min(desiredCount, filtered.length + filtered2.length));
        }
      } else {
        finalCards = filtered.slice(0, desiredCount);
      }
    } else {
      // Mixed: try to ensure distribution roughly matches desiredCounts; if too skewed, attempt a stricter retry once
      const totalDesired = distribution.easy + distribution.medium + distribution.hard;
      // small tolerance
      const tolerance = Math.max(1, Math.floor(count * 0.15));
      const diffEasy = Math.abs(counts.easy - distribution.easy);
      const diffMed = Math.abs(counts.medium - distribution.medium);
      const diffHard = Math.abs(counts.hard - distribution.hard);
      if (diffEasy + diffMed + diffHard > tolerance) {
        const stricterInstruction = 'Please adhere to the requested mixed distribution (easy/medium/hard counts).';
        const regener = await callGenerateFlashcards(sampledContent, distribution, `\n${stricterInstruction}`);
        const { validated: v2 } = validateAndClassify(regener, content, distribution);
        finalCards = v2;
      } else {
        finalCards = validated;
      }
    }

    // After finalCards determined, compute confidence and page mapping (best chunk)
    for (const c of finalCards) {
      c.confidence = computeSupportScore(c, content);
      // find best matching selected chunk
      let bestIdx = -1; let bestScore = 0;
      const cTokens = new Set(tokenizeWords(`${c.question} ${c.answer}`));
      for (let i = 0; i < selectedChunks.length; i++) {
        const chunkTokens = new Set(tokenizeWords(selectedChunks[i].text));
        let matches = 0;
        for (const t of cTokens) if (chunkTokens.has(t) && t.length >= 3) matches++;
        const score = cTokens.size ? matches / cTokens.size : 0;
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }
      if (bestIdx >= 0 && bestScore >= 0.05) {
        c.page_from = selectedChunks[bestIdx].page_from;
        c.page_to = selectedChunks[bestIdx].page_to;
      } else {
        const pos = content.toLowerCase().indexOf((c.answer || '').slice(0,50).toLowerCase());
        if (pos >= 0) {
          const estimatedPage = Math.floor(pos / CHARS_PER_PAGE_ESTIMATE) + 1;
          c.page_from = estimatedPage;
          c.page_to = estimatedPage;
        } else {
          c.page_from = null;
          c.page_to = null;
        }
      }
    }

    // Deduplicate and ensure we have at least one card
    const deduped = dedupeCards(finalCards, DEDUPE_JACCARD_THRESHOLD);
    if (deduped.length === 0) throw new Error('No valid flashcards after validation/deduplication.');

    // Insert flashcard set and flashcards with page_from/page_to
    const setTitle = `${document.title} - ${difficulty === 'mixed' ? 'Mixed' : difficulty.charAt(0).toUpperCase() + difficulty.slice(1)} (${deduped.length} cards)`;
    const { data: flashcardSet, error: setError } = await supabaseClient
      .from('flashcard_sets')
      .insert({
        user_id: user.id,
        document_id: documentId,
        title: setTitle,
        card_count: deduped.length,
        difficulty: difficulty
      })
      .select()
      .single();
    if (setError) throw setError;

    const flashcardsToInsert = deduped.map((card: any) => ({
      user_id: user.id,
      document_id: documentId,
      set_id: flashcardSet.id,
      question: card.question,
      answer: card.answer,
      difficulty: card.difficulty || 'medium',
      page_from: card.page_from ?? null,
      page_to: card.page_to ?? null,
    }));

    const { error: insertError } = await supabaseClient
      .from('flashcards')
      .insert(flashcardsToInsert);
    if (insertError) throw insertError;

    // Return helpful response including per-card confidence and page range
    const responseCards = deduped.map((c:any, i:number) => ({
      question: c.question,
      answer: c.answer,
      difficulty: c.difficulty || 'medium',
      confidence: c.confidence ?? 0,
      page_from: c.page_from ?? null,
      page_to: c.page_to ?? null,
    }));

    return new Response(JSON.stringify({
      success: true,
      count: flashcardsToInsert.length,
      flashcards: responseCards,
      usedOcr,
      language: detectedLanguage
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('Error generating flashcards:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return new Response(JSON.stringify({ error: errorMessage }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
