// supabase/functions/generate-flashcards/index.ts
// Updated: deduplication and per-card confidence (returned in response).

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// --- Helper functions (extraction, cleaning, OCR, tokenization, chunking, scoring) ---
// (These are the same helpers used in previous version: extractTextFromPDF, isBinaryContentFromBuffer, cleanTextContent,
// callExternalOCR, tokenizeWords, getTopKeywords, chunkTextByChars, scoreChunksByKeywords, selectTopChunks,
// detectLanguageByStopwords, supportedBySource)
// For brevity in this view, keep all previous helper implementations exactly as before (they remain in the real file).

// Minimal implementations are included here (keep them consistent with earlier version).
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
  return textParts.join(' ').replace(/\s+/g, ' ').trim();
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
    if (slice) chunks.push({ id: `c${id++}`, text: slice, start, end });
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
    for (const t of tokens) if (kwSet.has(t)) score++;
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
    if (v > bestCount) { best = k; bestCount = v; }
  }
  const confidence = totalMatches ? bestCount / totalMatches : 0;
  const names: Record<string, string> = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian' };
  return { code: best, name: names[best] || best, confidence };
}

// --- New: Deduplication and confidence computation ---

function normalizeTextForSimilarity(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function computeJaccard(a: string, b: string): number {
  const sa = new Set(tokenizeWords(normalizeTextForSimilarity(a)));
  const sb = new Set(tokenizeWords(normalizeTextForSimilarity(b)));
  if (sa.size === 0 || sb.size === 0) return 0;
  const intersection = [...sa].filter(x => sb.has(x)).length;
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : intersection / union;
}

// Confidence/support score between 0 and 1: average of question-support and answer-support token overlap ratios
function computeSupportScore(card: { question: string; answer: string }, source: string): number {
  const qTokens = tokenizeWords(normalizeTextForSimilarity(card.question || ''));
  const aTokens = tokenizeWords(normalizeTextForSimilarity(card.answer || ''));
  const sourceTokens = new Set(tokenizeWords(normalizeTextForSimilarity(source)));
  function overlapRatio(tokens: string[]) {
    if (!tokens.length) return 0;
    let matches = 0;
    for (const t of tokens) {
      if (t.length < 3) continue;
      if (sourceTokens.has(t)) matches++;
    }
    return tokens.length ? matches / tokens.length : 0;
  }
  const qScore = overlapRatio(qTokens);
  const aScore = overlapRatio(aTokens);
  // weight answer slightly higher
  return Math.min(1, (0.4 * qScore) + (0.6 * aScore));
}

// Remove near-duplicate cards based on combined question+answer similarity
function dedupeCards(cards: any[], threshold = 0.7): any[] {
  const unique: any[] = [];
  for (const c of cards) {
    const combined = `${c.question} ||| ${c.answer}`;
    let isDup = false;
    for (const u of unique) {
      const uCombined = `${u.question} ||| ${u.answer}`;
      const sim = computeJaccard(combined, uCombined);
      if (sim >= threshold) {
        isDup = true;
        // keep the card with higher confidence if present
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

// --- Main serverless handler (flow kept from previous version) ---
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { documentId, count = 10, difficulty = 'mixed', startPage, endPage } = await req.json();
    console.log('Generating flashcards for document:', documentId, 'count:', count, 'difficulty:', difficulty, 'pages:', startPage, '-', endPage);

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
      console.log('Downloaded file bytes:', rawBuffer.length);

      const looksBinary = isBinaryContentFromBuffer(rawBuffer);
      console.log('looksBinary:', looksBinary);

      if (looksBinary) {
        const rawLatin1 = new TextDecoder('latin1').decode(rawBuffer);
        content = extractTextFromPDF(rawLatin1);
        console.log('Extracted text length from pdf heuristics:', content.length);

        if (!content || content.length < 100) {
          const OCR_API_URL = Deno.env.get('OCR_API_URL') ?? '';
          const OCR_API_KEY = Deno.env.get('OCR_API_KEY') ?? '';
          if (OCR_API_URL) {
            const b64 = btoa(String.fromCharCode(...rawBuffer));
            const ocrText = await callExternalOCR(OCR_API_URL, OCR_API_KEY, b64);
            if (ocrText && ocrText.length > content.length) {
              usedOcr = true;
              content = ocrText;
              console.log('OCR returned text length:', content.length);
            }
          } else {
            throw new Error('Could not extract selectable text from this PDF (likely scanned). Enable OCR or upload text-based doc.');
          }
        }
      } else {
        const rawText = new TextDecoder('utf-8').decode(rawBuffer);
        content = cleanTextContent(rawText);
        console.log('Treated file as text, length:', content.length);
      }
    }

    if (!content || content.length < 100) {
      throw new Error('Document appears to be empty or unreadable.');
    }

    detectedLanguage = detectLanguageByStopwords(content);
    console.log('Detected language:', detectedLanguage);

    // Relevance selection (chunking & keywords) - same as earlier version
    const CHUNK_SIZE = 2200;
    const OVERLAP = 300;
    const MAX_CONTENT_SIZE = 30000;
    const allChunks = chunkTextByChars(content, CHUNK_SIZE, OVERLAP);
    console.log('Total chunks created:', allChunks.length);

    let contentForKeywords = content;
    if (startPage || endPage) {
      const CHARS_PER_PAGE = 3000;
      const totalEstimatedPages = Math.ceil(content.length / CHARS_PER_PAGE);
      const start = Math.max(0, ((startPage || 1) - 1) * CHARS_PER_PAGE);
      const end = Math.min(content.length, (endPage || totalEstimatedPages) * CHARS_PER_PAGE);
      contentForKeywords = content.substring(start, end);
      console.log('Keyword extraction range:', start, 'to', end);
    }

    const topKeywords = getTopKeywords(contentForKeywords, 60);
    console.log('Top keywords (sample):', topKeywords.slice(0, 12));
    let scoredChunks = scoreChunksByKeywords(allChunks, topKeywords);
    const totalScore = scoredChunks.reduce((s, c) => s + (c.score || 0), 0);
    let selectedChunks: Chunk[] = [];
    if (totalScore === 0) {
      console.log('Keyword scoring yielded zero total score — falling back to even sampling.');
      const chunkSize = 2000;
      const numChunks = Math.floor(MAX_CONTENT_SIZE / chunkSize) || 1;
      const step = Math.floor(content.length / numChunks);
      const fallback: Chunk[] = [];
      for (let i = 0; i < numChunks; i++) {
        const s = i * step;
        fallback.push({ id: `f${i}`, text: content.substring(s, s + chunkSize), start: s, end: s + chunkSize });
      }
      selectedChunks = fallback;
    } else {
      selectedChunks = selectTopChunks(scoredChunks, MAX_CONTENT_SIZE);
    }

    console.log('Selected chunk ids:', selectedChunks.map(c => `${c.id}@${c.start}-${c.end}`));
    const sampledContent = selectedChunks.map(c => c.text).join('\n\n');
    console.log('Sampled content length after relevance selection:', sampledContent.length);

    // Prepare prompt parts (few-shot examples etc)
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
                      question: { type: 'string', description: 'The flashcard question' },
                      answer: { type: 'string', description: 'The answer' },
                      difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] }
                    },
                    required: ['question', 'answer', 'difficulty']
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

      const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!aiResponse.ok) {
        const errorText = await aiResponse.text();
        console.error('AI Gateway error:', aiResponse.status, errorText);
        throw new Error(`AI Gateway error: ${aiResponse.status}`);
      }

      const aiData = await aiResponse.json();
      console.log('AI response received');
      console.log('AI response structure:', JSON.stringify(aiData, null, 2).substring(0, 2000));

      const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
      if (!toolCall) {
        console.error('No tool call found in response');
        throw new Error('No flashcards generated - AI did not return expected format');
      }

      let flashcardsData;
      try {
        flashcardsData = JSON.parse(toolCall.function.arguments);
      } catch (parseError) {
        console.error('Failed to parse tool call arguments:', parseError);
        throw new Error('Failed to parse flashcard data from AI');
      }

      const flashcards = flashcardsData.flashcards || [];
      if (!Array.isArray(flashcards) || flashcards.length === 0) {
        console.error('No flashcards generated. Data:', JSON.stringify(flashcardsData));
        throw new Error('AI failed to generate flashcards. Please try again.');
      }
      return flashcards;
    }

    // Generate flashcards via AI
    let flashcards = await callGenerateFlashcards(sampledContent);

    // Validate flashcards vs source
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
    console.log('Initial validation supportRate:', supportRate, 'validatedCount:', validated.length);

    if (supportRate < 0.6) {
      console.log('Support rate low (<0.6), retrying generation with stricter instruction...');
      const stricterInstruction = 'IMPORTANT: Only create flashcards that are directly supported by the text above. If unsure, omit the card.';
      flashcards = await callGenerateFlashcards(sampledContent, `\n${stricterInstruction}`);
      ({ validated, supportRate } = validateFlashcards(flashcards, content));
      console.log('Post-retry validation supportRate:', supportRate, 'validatedCount:', validated.length);
    }

    if (supportRate < 0.5 || validated.length === 0) {
      console.error('Validation failed — insufficient supported flashcards. Support rate:', supportRate);
      throw new Error('AI-generated flashcards were not sufficiently supported by the document text. This document may be unsuitable for automatic flashcard generation. Try a text-based document, enable OCR, or edit the document to include clearer content.');
    }

    // Compute per-card confidence/support score
    for (const c of validated) {
      c.confidence = computeSupportScore(c, content);
    }

    // Deduplicate validated cards
    const dedupeThreshold = 0.7; // adjust as needed
    const deduped = dedupeCards(validated, dedupeThreshold);
    console.log('After deduplication: validated ->', validated.length, ', deduped ->', deduped.length);

    if (deduped.length === 0) {
      throw new Error('All generated flashcards were filtered out as duplicates or unsupported.');
    }

    // Create flashcard set
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
    console.log('Created flashcard set:', flashcardSet.id);

    // Prepare DB insert (do not persist confidence to DB because schema lacks that column)
    const flashcardsToInsert = deduped.map((card: any) => ({
      user_id: user.id,
      document_id: documentId,
      set_id: flashcardSet.id,
      question: card.question,
      answer: card.answer,
      difficulty: card.difficulty || 'medium',
      // confidence is returned to client but not inserted into DB to avoid schema changes
    }));

    const { error: insertError } = await supabaseClient
      .from('flashcards')
      .insert(flashcardsToInsert);

    if (insertError) throw insertError;

    // Return inserted cards with confidence values (client can display them)
    const responseCards = deduped.map((c: any, i: number) => ({
      id: flashcardsToInsert[i]?.id || null,
      question: c.question,
      answer: c.answer,
      difficulty: c.difficulty || 'medium',
      confidence: c.confidence ?? 0
    }));

    console.log(`Successfully created ${flashcardsToInsert.length} flashcards (validated & deduped)`);

    return new Response(
      JSON.stringify({
        success: true,
        count: flashcardsToInsert.length,
        flashcards: responseCards,
        usedOcr,
        language: detectedLanguage
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error generating flashcards:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
