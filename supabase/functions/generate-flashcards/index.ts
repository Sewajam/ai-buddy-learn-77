// supabase/functions/generate-flashcards/index.ts
// Updated: relevance-based chunking & top-keyword selection to choose best chunks for LLM prompt.

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// --- Existing helper functions (extractTextFromPDF, isBinaryContentFromBuffer, cleanTextContent, callExternalOCR, supportedBySource, detectLanguageByStopwords) ---
// For brevity: keep implementations from previous version unchanged.
// (In your real file these functions remain the same as prior replacement: extractTextFromPDF, isBinaryContentFromBuffer, cleanTextContent, callExternalOCR, supportedBySource, detectLanguageByStopwords)

function extractTextFromPDF(binaryContent: string): string {
  const textParts: string[] = [];
  const tjMatches = binaryContent.match(/\(([^)]+)\)\s*Tj/g);
  if (tjMatches) {
    for (const match of tjMatches) {
      const text = match.replace(/\(([^)]+)\)\s*Tj/, '$1');
      if (text && /^[\x20-\x7E\s]+$/.test(text)) {
        textParts.push(text);
      }
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
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code > 126) {
      nonPrintable++;
    }
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

// --- New: chunking & keyword-based relevance selection ---

type Chunk = { id: string; text: string; start: number; end: number; score?: number };

// Basic tokenizer and stopword removal (English stopwords list, lightweight)
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

// --- Main serverless handler (mostly unchanged flow) ---
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

    // --- Relevance-based chunking + selection (fix for problem #2) ---
    const CHUNK_SIZE = 2200;
    const OVERLAP = 300;
    const MAX_CONTENT_SIZE = 30000;

    const allChunks = chunkTextByChars(content, CHUNK_SIZE, OVERLAP);
    console.log('Total chunks created:', allChunks.length);

    // Restrict keyword extraction to the full content or to the selected page-range slice
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
    // If scoring produced all-zero scores or few keywords, fallback to evenly spaced sampling (previous approach)
    const totalScore = scoredChunks.reduce((s, c) => s + (c.score || 0), 0);
    let selectedChunks: Chunk[] = [];
    if (totalScore === 0) {
      console.log('Keyword scoring yielded zero total score — falling back to even sampling.');
      // fallback: evenly spaced sampling strategy
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

    // --- Rest of flow: call AI gateway with sampledContent, validate results, insert validated cards ---
    // (Keep the same callGenerateFlashcards, validateFlashcards, retry logic, DB insert as in previous version.)
    // For brevity, re-use the prompt, few-shot examples, retry, validation and DB insertion logic from the prior implementation.
    // (In your real file, the lower half of the function remains as before, using sampledContent.)
    // To keep this file self-contained, below is the remaining required logic:

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

    let flashcards = await callGenerateFlashcards(sampledContent);

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
      const stricterInstruction = 'IMPORTANT: Only create flashcards that are directly supported by the text above. If unsure, omit the card.';
      flashcards = await callGenerateFlashcards(sampledContent, `\n${stricterInstruction}`);
      ({ validated, supportRate } = validateFlashcards(flashcards, content));
      console.log('Post-retry validation supportRate:', supportRate, 'validatedCount:', validated.length);
    }

    if (supportRate < 0.5 || validated.length === 0) {
      throw new Error('AI-generated flashcards were not sufficiently supported by the document text. This document may be unsuitable for automatic flashcard generation. Try a text-based document, enable OCR, or edit the document to include clearer content.');
    }

    const setTitle = `${document.title} - ${difficulty === 'mixed' ? 'Mixed' : difficulty.charAt(0).toUpperCase() + difficulty.slice(1)} (${validated.length} cards)`;
    const { data: flashcardSet, error: setError } = await supabaseClient
      .from('flashcard_sets')
      .insert({
        user_id: user.id,
        document_id: documentId,
        title: setTitle,
        card_count: validated.length,
        difficulty: difficulty
      })
      .select()
      .single();

    if (setError) throw setError;

    const flashcardsToInsert = validated.map((card: any) => ({
      user_id: user.id,
      document_id: documentId,
      set_id: flashcardSet.id,
      question: card.question,
      answer: card.answer,
      difficulty: card.difficulty || 'medium',
    }));

    const { error: insertError } = await supabaseClient
      .from('flashcards')
      .insert(flashcardsToInsert);

    if (insertError) throw insertError;

    return new Response(
      JSON.stringify({
        success: true,
        count: flashcardsToInsert.length,
        flashcards: flashcardsToInsert,
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
