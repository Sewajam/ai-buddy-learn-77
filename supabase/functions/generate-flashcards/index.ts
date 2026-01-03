// supabase/functions/generate-flashcards/index.ts
// Fully integrated: page-aware chunking + page_from/page_to mapping,
// robust extraction (binary handling + OCR fallback), language detection,
// relevance-based chunk selection, validation, dedupe, and DB insertion.
//
// NOTE: This file expects the database to have added integer columns
// `page_from` and `page_to` to the public.flashcards table (migration needed).

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// -------------------- Config --------------------
const CHARS_PER_PAGE_ESTIMATE = 3000;
const CHUNK_SIZE = 2200;
const CHUNK_OVERLAP = 300;
const MAX_CONTENT_SIZE = 30000; // characters
const DEDUPE_JACCARD_THRESHOLD = 0.7;
const SUPPORT_RETRY_THRESHOLD = 0.6;
const MIN_ACCEPT_SUPPORT_RATE = 0.5;

// -------------------- Utility helpers --------------------

function collapseWhitespace(s: string) {
  return s.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

// Extract readable text from PDF-like binary content using heuristics
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

// Heuristic binary detection from raw bytes
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

// Clean text: remove control chars, collapse whitespace
function cleanTextContent(content: string): string {
  let cleaned = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ');
  cleaned = cleaned.replace(/\b[\w]{1,2}\b/g, ' ').replace(/\s+/g, ' ');
  return cleaned.trim();
}

// Very small OCR caller (expects OCR_API_URL that accepts { file: base64 } and returns { text })
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

// Tokenization & stopword set (lightweight)
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

// Page splitting: try to preserve explicit page boundaries, else estimate by CHARS_PER_PAGE_ESTIMATE
function splitIntoPages(content: string): string[] {
  // Try common page separators
  if (!content) return [];
  // 1) Form feed characters
  let pages = content.split(/\f/).map(s=>s.trim()).filter(Boolean);
  if (pages.length > 1) return pages;
  // 2) Lines like "Page 1" - split before "Page <num>"
  pages = content.split(/\n(?=Page\s+\d+\b)/).map(s=>s.trim()).filter(Boolean);
  if (pages.length > 1) return pages;
  // 3) Fall back to estimate by characters per page
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

// Chunk a page's text into chunks with overlap. Each chunk will carry page_from/page_to metadata.
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

// Score chunks by keyword overlap
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

// Basic small-language detection via stopword frequency
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

// Simple token-presence support check
function supportedBySource(needle: string, haystack: string): boolean {
  if (!needle || !haystack) return false;
  const tokens = tokenizeWords(needle).filter(t => t.length >= 3);
  if (tokens.length === 0) return false;
  const hs = haystack.toLowerCase();
  for (const t of tokens) {
    if (hs.includes(t)) return true;
  }
  return false;
}

// Jaccard similarity for dedupe
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

    // Use stored content if available, otherwise download and extract
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

    // Page-aware splitting
    const pages = splitIntoPages(content);
    // If user requested page range, narrow pages
    let pagesToUse = pages;
    if (startPage || endPage) {
      const from = Math.max(1, startPage || 1);
      const to = Math.min(pages.length, endPage || pages.length);
      pagesToUse = pages.slice(from-1, to);
    }

    // Build chunks per page
    const allChunks = chunkPagesToChunks(pagesToUse, CHUNK_SIZE, CHUNK_OVERLAP);

    // Relevance scoring via keywords
    const contentForKeywords = pagesToUse.join(' ');
    const topKeywords = getTopKeywords(contentForKeywords, 60);
    let scoredChunks = scoreChunksByKeywords(allChunks, topKeywords);

    // If scoring yields zero scores, fallback to evenly spaced sampling across content
    const totalScore = scoredChunks.reduce((s,c)=>s+(c.score||0),0);
    let selectedChunks: Chunk[] = [];
    if (totalScore === 0) {
      // evenly sample across pagesToUse
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

    // Prepare sampled content for prompt and include page markers
    const sampledContentParts: string[] = selectedChunks.map(c => `SOURCE (pages ${c.page_from}${c.page_to && c.page_to !== c.page_from ? `-${c.page_to}` : ''}):\n${c.text}`);
    const sampledContent = sampledContentParts.join('\n\n');

    // Prepare prompt with few-shot examples and language enforcement + deterministic params
    const difficultyInstruction = difficulty === 'mixed'
      ? 'Create a balanced mix: some easy (basic facts), some medium (connections), some hard (analysis)'
      : `All ${difficulty} difficulty`;

    const fewShotExamples = `
EXAMPLES (format: question | answer | difficulty):

Easy example:
Q: What is photosynthesis?
A: Photosynthesis is the process by which green plants use sunlight to synthesize foods from carbon dioxide and water.
Difficulty: easy

Medium example:
Q: How does the structure of a leaf support photosynthesis?
A: The large surface area and thin structure of leaves allow more light absorption and efficient gas exchange, supporting photosynthesis.
Difficulty: medium

Hard example:
Q: Explain how light intensity and CO2 concentration interact to limit photosynthetic rate and how a plant might physiologically respond.
A: At low light, photosynthesis is light-limited; as light increases CO2 or enzyme (Rubisco) becomes limiting. Plants may allocate resources to more chlorophyll or adjust stomatal conductance to balance CO2 uptake with water loss.
Difficulty: hard
`;

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    async function callGenerateFlashcards(promptContent: string, instructionExtension = '') {
      const body = {
        model: 'google/gemini-2.5-flash',
        temperature: 0.2,
        top_p: 0.9,
        max_tokens: 2000,
        messages: [
          {
            role: 'system',
            content: `You are creating ${count} study flashcards about the educational content provided.

RULES:
1. Create questions ONLY about facts, concepts, definitions, and information IN the provided text
2. Use direct recall questions: What is...? Define... Explain... Who... When... How...
3. Questions and answers must be in the SAME language as the source text
4. ${difficultyInstruction}
5. NEVER ask about: documents, files, systems, formats, metadata, flashcards themselves
BE SURE: Use ONLY the information present inside the SOURCE text provided by the user. If an answer is not explicitly supported by the SOURCE, omit that card. Output should be a function call to create_flashcards as defined in the tools parameter.
REPLY IN: ${detectedLanguage.name}
${instructionExtension}`
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

      const flashcards = flashcardsData.flashcards || [];
      if (!Array.isArray(flashcards) || flashcards.length === 0) {
        console.error('AI returned no flashcards:', JSON.stringify(flashcardsData));
        throw new Error('AI failed to generate flashcards. Please try again.');
      }
      return flashcards;
    }

    // First attempt
    let flashcards = await callGenerateFlashcards(sampledContent);

    // Validate support against source
    function validateFlashcards(cards: any[], source: string) {
      let supported = 0;
      const validated: any[] = [];
      for (const c of cards) {
        const qOk = supportedBySource(c.question || '', source);
        const aOk = supportedBySource(c.answer || '', source);
        if (qOk || aOk) supported++;
        if (qOk || aOk) validated.push(c);
        if (!c.difficulty) c.difficulty = 'medium';
      }
      const supportRate = cards.length ? (supported / cards.length) : 0;
      return { validated, supportRate };
    }

    let { validated, supportRate } = validateFlashcards(flashcards, content);

    if (supportRate < SUPPORT_RETRY_THRESHOLD) {
      const stricterInstruction = 'IMPORTANT: Only create flashcards that are directly supported by the text above. If unsure, omit the card.';
      flashcards = await callGenerateFlashcards(sampledContent, `\n${stricterInstruction}`);
      ({ validated, supportRate } = validateFlashcards(flashcards, content));
    }

    if (supportRate < MIN_ACCEPT_SUPPORT_RATE || validated.length === 0) {
      throw new Error('AI-generated flashcards were not sufficiently supported by the document text. Try a text-based document, enable OCR, or edit the document to include clearer content.');
    }

    // Compute confidence per card and map to page ranges by finding best matching selected chunk
    for (const c of validated) {
      c.confidence = computeSupportScore(c, content);
      // find best chunk match among selectedChunks
      let bestIdx = -1;
      let bestScore = 0;
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
        // best-effort fallback: estimate page by searching for answer snippet in content and mapping char offset -> page
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

    // Deduplicate validated cards
    for (const c of validated) {
      if (c.confidence === undefined) c.confidence = computeSupportScore(c, content);
    }
    const deduped = dedupeCards(validated, DEDUPE_JACCARD_THRESHOLD);

    if (deduped.length === 0) {
      throw new Error('All generated flashcards were filtered out as duplicates or unsupported.');
    }

    // Create flashcard_set in DB
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

    // Insert flashcards with page_from/page_to
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

    // Prepare response: include confidence and page range for UI
    const responseCards = deduped.map((c: any, i: number) => ({
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
