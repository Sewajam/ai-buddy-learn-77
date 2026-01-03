// supabase/functions/generate-flashcards/index.ts
// Updated: enforces answer-length/type rules per difficulty by validating and
// normalizing answers where safe (shortening / extracting source sentences).
// Builds on the previous implementation (extraction, chunking, language enforcement,
// validation, dedupe, page mapping, difficulty distribution).
//
// Note: This file expects the DB migration that added `page_from` and `page_to` to `flashcards`.

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

// Difficulty answer length rules (by word count & sentence count)
const DIFFICULTY_RULES: Record<string, { minWords:number; maxWords:number; maxSentences:number }> = {
  easy: { minWords: 1, maxWords: 12, maxSentences: 1 },
  medium: { minWords: 13, maxWords: 40, maxSentences: 2 },
  hard: { minWords: 41, maxWords: 250, maxSentences: 6 },
};

const MIXED_DISTRIBUTION = { easy: 0.4, medium: 0.4, hard: 0.2 };

// -------------------- Helper utilities (extraction, tokenization, chunking, etc.) ---
// (Use the same helpers as in previous versions: extractTextFromPDF, isBinaryContentFromBuffer,
// cleanTextContent, callExternalOCR, tokenizeWords, getTopKeywords, splitIntoPages,
// chunkPagesToChunks, scoreChunksByKeywords, selectTopChunksByChars, detectLanguageByStopwords,
// supportedBySource, computeJaccard, computeSupportScore, dedupeCards)
//
// For brevity the full implementations are included below; they match the logic used earlier.

function collapseWhitespace(s: string) { return s.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim(); }

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
      if (!match.includes('stream') && !match.includes('endobj') && !match.includes('/Type') && !match.includes('/Font') && !match.includes('<<') && !match.includes('>>')) {
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
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
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

const STOPWORDS = new Set(['the','and','is','in','to','of','a','that','it','on','for','as','with','was','were','be','by','an','this','which','or','are','from','at','but','not','have','has','had']);

function tokenizeWords(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
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
    const start = i * CHARS_PER_PAGE_ESTIMATE, end = Math.min(total, (i+1)*CHARS_PER_PAGE_ESTIMATE);
    res.push(content.slice(start, end).trim());
  }
  return res.filter(Boolean);
}

type Chunk = { id: string; text: string; page_from: number; page_to: number; start: number; end: number; score?: number };

function chunkPagesToChunks(pages: string[], chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): Chunk[] {
  const chunks: Chunk[] = [];
  let id = 0; let globalOffset = 0;
  for (let p = 0; p < pages.length; p++) {
    const pageText = pages[p] || '';
    let start = 0;
    while (start < pageText.length) {
      const end = Math.min(start + chunkSize, pageText.length);
      const slice = pageText.slice(start, end).trim();
      if (slice) {
        chunks.push({ id:`c${id++}`, text: slice, page_from: p+1, page_to: p+1, start: globalOffset + start, end: globalOffset + end });
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
  return chunks.sort((a,b)=> (b.score || 0) - (a.score || 0));
}

function selectTopChunksByChars(chunks: Chunk[], maxChars = MAX_CONTENT_SIZE): Chunk[] {
  const selected: Chunk[] = [];
  let used = 0;
  for (const c of chunks) {
    if (used + c.text.length > maxChars) continue;
    selected.push(c); used += c.text.length;
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
  const counts: Record<string, number> = {}; let total = 0;
  for (const [k, words] of Object.entries(samples)) {
    let c = 0;
    for (const w of words) {
      const m = lower.match(new RegExp(`\\b${w}\\b`, 'g'));
      if (m) c += m.length;
    }
    counts[k] = c; total += c;
  }
  let best='en', bestCount=0;
  for (const [k,v] of Object.entries(counts)) if (v > bestCount) { best = k; bestCount = v; }
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
          u.question = c.question; u.answer = c.answer; u.difficulty = c.difficulty || u.difficulty; u.confidence = c.confidence;
        }
        break;
      }
    }
    if (!isDup) unique.push(c);
  }
  return unique;
}

// -------------------- Answer-length enforcement & normalization helpers (Problem #19) --------------------

function wordCount(s: string) {
  if (!s) return 0;
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function sentenceCount(s: string) {
  if (!s) return 0;
  return s.split(/[.?!]+/).map(p=>p.trim()).filter(Boolean).length;
}

// Try to extract a concise sentence from the source containing the answer text (if present)
function extractSentenceContaining(answer: string, source: string): string | null {
  if (!answer || !source) return null;
  const idx = source.toLowerCase().indexOf(answer.slice(0, Math.min(60, answer.length)).toLowerCase());
  if (idx === -1) return null;
  // find sentence boundaries around idx
  const before = source.lastIndexOf('.', idx);
  const start = before === -1 ? Math.max(0, idx - 200) : before + 1;
  const after = source.indexOf('.', idx);
  const end = after === -1 ? Math.min(source.length, idx + 200) : after + 1;
  const sentence = source.slice(start, end).trim();
  return sentence || null;
}

// Shorten text to maxWords preserving whole words; append ellipsis if trimmed
function shortenToWords(text: string, maxWords: number) {
  const tokens = (text || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= maxWords) return text.trim();
  return tokens.slice(0, maxWords).join(' ') + (tokens.length > maxWords ? '...' : '');
}

// Enforce/normalize an answer according to difficulty rules. Returns { ok, normalized, newAnswer, reason }
function enforceAnswerForDifficulty(card: { question:string; answer:string }, difficulty: 'easy'|'medium'|'hard', source: string) {
  const rules = DIFFICULTY_RULES[difficulty];
  const ans = (card.answer || '').trim();
  const wc = wordCount(ans);
  const sc = sentenceCount(ans);

  // If already compliant, return ok
  if (wc >= rules.minWords && wc <= rules.maxWords && sc <= rules.maxSentences) {
    return { ok: true, normalized: false, newAnswer: ans, reason: 'compliant' };
  }

  // Try to extract a source sentence containing the answer or question (prefer source)
  const fromSource = extractSentenceContaining(ans, source) || extractSentenceContaining(card.question || '', source);
  if (fromSource) {
    // If fromSource is short enough, use it (possibly shorten)
    let candidate = fromSource.trim();
    if (wordCount(candidate) > rules.maxWords || sentenceCount(candidate) > rules.maxSentences) {
      candidate = shortenToWords(candidate, rules.maxWords);
    }
    // Ensure candidate meets minWords; if not, we'll consider fallback
    if (wordCount(candidate) >= Math.min(rules.minWords, 1)) {
      return { ok: true, normalized: candidate, newAnswer: candidate, reason: 'extracted_from_source' };
    }
  }

  // If answer is too long (common for easy/medium), shorten it gracefully
  if (wc > rules.maxWords) {
    // Take first sentence if that fits
    const firstSentence = ans.split(/[.?!]+/)[0].trim();
    let candidate = firstSentence;
    if (wordCount(candidate) > rules.maxWords) candidate = shortenToWords(candidate, rules.maxWords);
    if (wordCount(candidate) >= Math.min(rules.minWords, 1)) {
      return { ok: true, normalized: true, newAnswer: candidate, reason: 'shortened_from_answer' };
    } else {
      // fallback: take first N words from original answer
      const candidate2 = shortenToWords(ans, rules.maxWords);
      if (wordCount(candidate2) >= Math.min(rules.minWords, 1)) {
        return { ok: true, normalized: true, newAnswer: candidate2, reason: 'truncated' };
      }
    }
  }

  // If answer is too short (rare), attempt to expand using nearby sentence in source
  if (wc < rules.minWords && fromSource) {
    // try to return a slightly larger context from source but within maxWords
    const candidate = shortenToWords(fromSource, Math.min(rules.maxWords, Math.max(rules.minWords, 12)));
    if (wordCount(candidate) >= rules.minWords) {
      return { ok: true, normalized: true, newAnswer: candidate, reason: 'expanded_from_source' };
    }
  }

  // If nothing works, mark not ok (caller may decide to regenerate or keep)
  return { ok: false, normalized: false, newAnswer: ans, reason: 'cannot_normalize' };
}

// -------------------- Main handler (building on earlier difficulty-aware function) --------------------

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

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

    // Extraction - use AI to extract text from PDF
    let content = document.content || '';
    let detectedLanguage = { code: 'und', name: 'Unknown', confidence: 0 };
    let pdfBase64: string | null = null;

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    if (!content || content.length < 100) {
      const { data: fileData, error: fileError } = await supabaseClient.storage.from('documents').download(document.file_path);
      if (fileError) throw fileError;
      const rawBuffer = new Uint8Array(await fileData.arrayBuffer());
      const looksBinary = isBinaryContentFromBuffer(rawBuffer);
      
      if (looksBinary) {
        // Store base64 for direct PDF processing with AI
        pdfBase64 = btoa(String.fromCharCode(...rawBuffer));
        console.info('PDF detected, will use AI for text extraction. Size:', rawBuffer.length);
        
        // Use AI to extract text from the PDF
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
          throw new Error('Could not extract text from PDF. Please try a different document.');
        }
      } else {
        content = cleanTextContent(new TextDecoder('utf-8').decode(rawBuffer));
      }
    }

    if (!content || content.length < 100) throw new Error('Document appears to be empty or unreadable.');

    detectedLanguage = detectLanguageByStopwords(content);

    // Page-aware chunking & relevance selection
    const pages = splitIntoPages(content);
    let pagesToUse = pages;
    if (startPage || endPage) {
      const from = Math.max(1, startPage || 1);
      const to = Math.min(pages.length, endPage || pages.length);
      pagesToUse = pages.slice(from - 1, to);
    }
    const allChunks = chunkPagesToChunks(pagesToUse, CHUNK_SIZE, CHUNK_OVERLAP);
    const topKeywords = getTopKeywords(pagesToUse.join(' '), 60);
    let scoredChunks = scoreChunksByKeywords(allChunks, topKeywords);
    const totalScore = scoredChunks.reduce((s,c)=>s+(c.score||0),0);
    let selectedChunks: Chunk[] = [];
    if (totalScore === 0) {
      const fallback: Chunk[] = [];
      const flat = pagesToUse.join('\n\n');
      const numChunks = Math.floor(MAX_CONTENT_SIZE / CHUNK_SIZE) || 1;
      const step = Math.floor(flat.length / numChunks);
      for (let i=0;i<numChunks;i++){
        const s=i*step; const slice = flat.substring(s, s+CHUNK_SIZE);
        fallback.push({ id:`f${i}`, text: slice, page_from: 1, page_to: pagesToUse.length, start: s, end: s+slice.length });
      }
      selectedChunks = fallback;
    } else {
      selectedChunks = selectTopChunksByChars(scoredChunks, MAX_CONTENT_SIZE);
    }
    const sampledContentParts = selectedChunks.map(c => `SOURCE (pages ${c.page_from}${c.page_to && c.page_to !== c.page_from ? `-${c.page_to}` : ''}):\n${c.text}`);
    const sampledContent = sampledContentParts.join('\n\n');

    // Difficulty planning
    function desiredCountsForDifficulty(totalCount: number, difficultyStr: string) {
      if (difficultyStr === 'mixed') {
        const easy = Math.round(totalCount * MIXED_DISTRIBUTION.easy);
        const medium = Math.round(totalCount * MIXED_DISTRIBUTION.medium);
        let hard = totalCount - easy - medium;
        if (hard < 0) hard = 0;
        const sum = easy + medium + hard;
        if (sum !== totalCount) {
          const diff = totalCount - sum;
          return { easy, medium: medium + diff, hard };
        }
        return { easy, medium, hard };
      } else if (['easy','medium','hard'].includes(difficultyStr)) {
        const obj:any = { easy:0, medium:0, hard:0 };
        obj[difficultyStr] = totalCount; return obj;
      }
      return desiredCountsForDifficulty(totalCount, 'mixed');
    }

    const desiredCounts = desiredCountsForDifficulty(count, difficulty);

    // Few-shot examples (kept short) and AI invocation (same patterns as earlier)
    const fewShotExamples = `
EXAMPLES (format: {"question":"...","answer":"...","difficulty":"easy|medium|hard"}):
{"question":"What is gravity?","answer":"Gravity is the force that attracts objects with mass toward each other.","difficulty":"easy"}
{"question":"How does Newton's second law relate force, mass, and acceleration?","answer":"Newton's second law states that force equals mass times acceleration (F = ma).","difficulty":"medium"}
{"question":"Explain how the double-slit experiment demonstrates wave-particle duality.","answer":"The double-slit experiment shows that light has wave-like interference when unobserved but exhibits particle-like detection when measured, demonstrating wave-particle duality.","difficulty":"hard"}
`;

    // LOVABLE_API_KEY already declared above

    async function callGenerateFlashcards(promptContent: string, distribution: {easy:number,medium:number,hard:number}, instructionExtension = '') {
      const distText = (distribution.easy + distribution.medium + distribution.hard) === count
        ? (difficulty === 'mixed'
          ? `Produce ${distribution.easy} easy, ${distribution.medium} medium, and ${distribution.hard} hard flashcards (total ${count}).`
          : `Produce ${count} ${difficulty} flashcards.`)
        : `Produce ${count} flashcards with a balanced mix.`;

      const body = {
        model: 'google/gemini-2.5-flash',
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 2000,
        messages: [
          { role: 'system', content:
`You are producing study flashcards formatted as JSON objects with fields: question, answer, difficulty ("easy","medium","hard").

RULES:
1) ${distText}
2) Questions must be directly answerable from the provided SOURCE text.
3) Difficulty rules (answers):
   - easy: concise factual recall, answer 1 sentence, 1–12 words.
   - medium: conceptual, 1–2 sentences (~13–40 words).
   - hard: analytical, 2–4 sentences (~41–250 words).
4) Output a function call to create_flashcards with payload: { "flashcards": [ ... ] }
5) Reply in the same language as the source text (REPLY IN: ${detectedLanguage.name}).
${instructionExtension}`
          },
          { role: 'user', content: `SOURCE:\n\n${promptContent}\n\n${fewShotExamples}` }
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
        headers: { 'Authorization': `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!r.ok) {
        const errText = await r.text();
        console.error('AI Gateway error:', r.status, errText);
        throw new Error(`AI Gateway error: ${r.status}`);
      }

      const aiData = await r.json();
      const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
      if (!toolCall) { console.error('No tool call found in response'); throw new Error('No flashcards generated - AI did not return expected format'); }
      let flashcardsData;
      try { flashcardsData = JSON.parse(toolCall.function.arguments); } catch (err) {
        console.error('Failed to parse tool call args:', err); throw new Error('Failed to parse flashcard data from AI');
      }
      const cards = flashcardsData.flashcards || [];
      if (!Array.isArray(cards) || cards.length === 0) { console.error('AI returned no flashcards:', JSON.stringify(flashcardsData)); throw new Error('AI failed to generate flashcards.'); }
      return cards;
    }

    // First generation attempt
    const desiredDistribution = desiredCountsForDifficulty(count, difficulty);
    let generated = await callGenerateFlashcards(sampledContent, desiredDistribution);
    function validateAndClassify(cards: any[], source: string) {
      const validated: any[] = [];
      let supported = 0;
      const counts = { easy:0, medium:0, hard:0 };
      for (const c of cards) {
        const qOk = supportedBySource(c.question || '', source);
        const aOk = supportedBySource(c.answer || '', source);
        if (qOk || aOk) supported++;
        let declared = (c.difficulty || '').toLowerCase();
        if (!['easy','medium','hard'].includes(declared)) declared = classifyAnswerDifficulty(c.answer);
        c.difficulty = declared;
        // prefer classification by content length if AI mislabeled
        const classified = classifyAnswerDifficulty(c.answer);
        if (classified !== declared) c.difficulty = classified;
        validated.push(c);
        const diff = c.difficulty as 'easy' | 'medium' | 'hard';
        counts[diff] = (counts[diff] || 0) + 1;
      }
      const supportRate = cards.length ? (supported / cards.length) : 0;
      return { validated, supportRate, counts };
    }

    // helper re-used from earlier (we include classifyAnswerDifficulty here)
    function classifyAnswerDifficulty(answer: string) : 'easy'|'medium'|'hard' {
      const wc = wordCount(answer);
      const sc = sentenceCount(answer);
      if (wc <= DIFFICULTY_RULES.easy.maxWords && sc <= DIFFICULTY_RULES.easy.maxSentences) return 'easy';
      if (wc <= DIFFICULTY_RULES.medium.maxWords && sc <= DIFFICULTY_RULES.medium.maxSentences) return 'medium';
      return 'hard';
    }

    let { validated, supportRate, counts } = validateAndClassify(generated, content);
    if (supportRate < SUPPORT_RETRY_THRESHOLD) {
      const stricterInstruction = 'IMPORTANT: Only include cards directly supported by the SOURCE and strictly follow the requested difficulty distribution and answer-length rules.';
      generated = await callGenerateFlashcards(sampledContent, desiredDistribution, `\n${stricterInstruction}`);
      ({ validated, supportRate, counts } = validateAndClassify(generated, content));
    }
    if (supportRate < MIN_ACCEPT_SUPPORT_RATE) throw new Error('AI-generated flashcards were not sufficiently supported by the document text.');

    // Enforce/normalize answers to fit difficulty rules (Problem #19)
    const normalizedCards: any[] = [];
    for (const c of validated) {
      const diff = (c.difficulty || classifyAnswerDifficulty(c.answer)) as 'easy'|'medium'|'hard';
      const enforcement = enforceAnswerForDifficulty(c, diff, content);
      if (enforcement.ok) {
        // If normalized, update the answer
        if (enforcement.normalized && enforcement.newAnswer !== c.answer) {
          c.answer = enforcement.newAnswer;
          c._normalized = true;
          c._normalizationReason = enforcement.reason;
        } else {
          c._normalized = false;
        }
        normalizedCards.push(c);
      } else {
        // If cannot normalize, keep the card but mark as low-confidence and flag reason
        c._normalized = false;
        c._normalizationReason = enforcement.reason;
        c._normalizationFailed = true;
        normalizedCards.push(c);
      }
    }

    // After normalization recompute support/confidence
    for (const c of normalizedCards) c.confidence = computeSupportScore(c, content);

    // Optionally, if many cards failed normalization and support drops, attempt a regeneration
    const postSupportRate = normalizedCards.length ? (normalizedCards.filter(c => c.confidence > 0.1).length / normalizedCards.length) : 0;
    if (postSupportRate < MIN_ACCEPT_SUPPORT_RATE) {
      // try one more strict pass requesting answers conform to difficulty lengths
      const stricterInstruction = 'Please strictly follow the difficulty answer-length rules, and when necessary produce concise answers (shorten long answers).';
      const regenerated = await callGenerateFlashcards(sampledContent, desiredDistribution, `\n${stricterInstruction}`);
      const { validated: v2, supportRate: sr2 } = validateAndClassify(regenerated, content);
      if (sr2 >= MIN_ACCEPT_SUPPORT_RATE) {
        // replace normalizedCards with v2 (re-run normalization)
        const normalized2: any[] = [];
        for (const c of v2) {
          const diff = (c.difficulty || classifyAnswerDifficulty(c.answer)) as 'easy'|'medium'|'hard';
          const enforcement = enforceAnswerForDifficulty(c, diff, content);
          if (enforcement.ok) {
            if (enforcement.normalized && enforcement.newAnswer !== c.answer) {
              c.answer = enforcement.newAnswer; c._normalized = true; c._normalizationReason = enforcement.reason;
            } else c._normalized = false;
          } else { c._normalized = false; c._normalizationFailed = true; c._normalizationReason = enforcement.reason; }
          c.confidence = computeSupportScore(c, content);
          normalized2.push(c);
        }
        // use normalized2 if better
        if ((normalized2.filter(c=>c.confidence>0.1).length / normalized2.length) >= MIN_ACCEPT_SUPPORT_RATE) {
          // proceed with normalized2
          for (const c of normalized2) c.confidence = computeSupportScore(c, content);
          normalizedCards.splice(0, normalizedCards.length, ...normalized2);
        }
      }
    }

    // Deduplicate
    const deduped = dedupeCards(normalizedCards, DEDUPE_JACCARD_THRESHOLD);
    if (deduped.length === 0) throw new Error('No valid flashcards after normalization/deduplication.');

    // Map to page ranges and prepare DB insertion (same logic as earlier)
    for (const c of deduped) {
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
        c.page_from = selectedChunks[bestIdx].page_from; c.page_to = selectedChunks[bestIdx].page_to;
      } else {
        const pos = content.toLowerCase().indexOf((c.answer || '').slice(0,50).toLowerCase());
        if (pos >= 0) {
          const estimatedPage = Math.floor(pos / CHARS_PER_PAGE_ESTIMATE) + 1;
          c.page_from = estimatedPage; c.page_to = estimatedPage;
        } else { c.page_from = null; c.page_to = null; }
      }
    }

    // Insert flashcard set and cards into DB
    const setTitle = `${document.title} - ${difficulty === 'mixed' ? 'Mixed' : difficulty.charAt(0).toUpperCase() + difficulty.slice(1)} (${deduped.length} cards)`;
    const { data: flashcardSet, error: setError } = await supabaseClient
      .from('flashcard_sets').insert({ user_id: user.id, document_id: documentId, title: setTitle, card_count: deduped.length, difficulty }).select().single();
    if (setError) throw setError;

    const flashcardsToInsert = deduped.map((card:any) => ({
      user_id: user.id,
      document_id: documentId,
      set_id: flashcardSet.id,
      question: card.question,
      answer: card.answer,
      difficulty: card.difficulty || 'medium',
    }));

    const { error: insertError } = await supabaseClient.from('flashcards').insert(flashcardsToInsert);
    if (insertError) throw insertError;

    // Return response with normalization metadata to let UI surface which cards were adjusted
    const responseCards = deduped.map((c:any) => ({
      question: c.question,
      answer: c.answer,
      difficulty: c.difficulty || 'medium',
      confidence: c.confidence ?? 0,
      page_from: c.page_from ?? null,
      page_to: c.page_to ?? null,
      normalized: !!c._normalized,
      normalizationReason: c._normalizationReason || null,
      normalizationFailed: !!c._normalizationFailed,
    }));

    return new Response(JSON.stringify({ success: true, count: flashcardsToInsert.length, flashcards: responseCards, language: detectedLanguage }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('Error generating flashcards:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return new Response(JSON.stringify({ error: errorMessage }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
