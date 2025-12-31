// supabase/functions/generate-flashcards/index.ts
// Updated: language detection (heuristic), few-shot difficulty examples, deterministic model params.

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Extract readable text from PDF binary data (simple heuristics kept)
function extractTextFromPDF(binaryContent: string): string {
  const textParts: string[] = [];

  // Method 1: Extract text from PDF text objects (Tj, TJ operators)
  const tjMatches = binaryContent.match(/\(([^)]+)\)\s*Tj/g);
  if (tjMatches) {
    for (const match of tjMatches) {
      const text = match.replace(/\(([^)]+)\)\s*Tj/, '$1');
      if (text && /^[\x20-\x7E\s]+$/.test(text)) {
        textParts.push(text);
      }
    }
  }

  // Method 2: Extract readable ASCII sequences (longer runs of readable chars)
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

// Check if content looks like binary/garbage using sampling and PDF magic bytes
function isBinaryContentFromBuffer(buf: Uint8Array): boolean {
  // PDF magic check
  const pdfMagic = String.fromCharCode(...buf.slice(0, 5));
  if (pdfMagic === '%PDF-') return true;

  // Fallback heuristic: sample bytes for non-printables
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

// Clean text content to remove control chars and collapse whitespace
function cleanTextContent(content: string): string {
  let cleaned = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ');
  cleaned = cleaned.replace(/\b[\w]{1,2}\b/g, ' ').replace(/\s+/g, ' ');
  return cleaned.trim();
}

// Optional: call external OCR service (if configured) — expects OCR_API_URL + OCR_API_KEY
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

// Basic support check: does `needle` appear in `haystack` (case-insensitive, normalized)
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

// Lightweight language detection using stopword frequency for common languages
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
    const { documentId, count = 10, difficulty = 'mixed', startPage, endPage } = await req.json();
    console.log('Generating flashcards for document:', documentId, 'count:', count, 'difficulty:', difficulty, 'pages:', startPage, '-', endPage);

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

    // Get the document from DB
    const { data: document, error: docError } = await supabaseClient
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .maybeSingle();

    if (docError) throw docError;
    if (!document) throw new Error('Document not found');

    // Use stored content if available and large enough
    let content = document.content || '';
    let usedOcr = false;
    let detectedLanguage = { code: 'und', name: 'Unknown', confidence: 0 };

    if (!content || content.length < 100) {
      // Download the file content from storage
      const { data: fileData, error: fileError } = await supabaseClient
        .storage
        .from('documents')
        .download(document.file_path);

      if (fileError) throw fileError;

      // Read as ArrayBuffer to preserve binary
      const rawBuffer = new Uint8Array(await fileData.arrayBuffer());
      console.log('Downloaded file bytes:', rawBuffer.length);

      const looksBinary = isBinaryContentFromBuffer(rawBuffer);
      console.log('looksBinary:', looksBinary);

      if (looksBinary) {
        console.log('Detected likely binary/PDF file, attempting text extraction from PDF bytes...');
        // decode using latin1 to preserve byte values
        const rawLatin1 = new TextDecoder('latin1').decode(rawBuffer);
        content = extractTextFromPDF(rawLatin1);
        console.log('Extracted text length from pdf heuristics:', content.length);

        // If very short, try OCR fallback if configured
        if (!content || content.length < 100) {
          const OCR_API_URL = Deno.env.get('OCR_API_URL') ?? '';
          const OCR_API_KEY = Deno.env.get('OCR_API_KEY') ?? '';
          if (OCR_API_URL) {
            console.log('Attempting OCR fallback via OCR_API_URL');
            const b64 = btoa(String.fromCharCode(...rawBuffer));
            const ocrText = await callExternalOCR(OCR_API_URL, OCR_API_KEY, b64);
            if (ocrText && ocrText.length > content.length) {
              usedOcr = true;
              content = ocrText;
              console.log('OCR returned text length:', content.length);
            } else {
              console.log('OCR returned no usable text or failed');
            }
          } else {
            throw new Error('Could not extract selectable text from this PDF (likely scanned). Enable OCR (OCR_API_URL + OCR_API_KEY) in function environment OR upload a text-based document (.txt, .md, or a PDF with selectable text).');
          }
        }
      } else {
        // Treat as plain-text file
        const rawText = new TextDecoder('utf-8').decode(rawBuffer);
        content = cleanTextContent(rawText);
        console.log('Treated file as text, length:', content.length);
      }
    }

    console.log('Final document content length:', content.length);
    console.log('Content preview:', content.substring(0, 500));

    if (!content || content.length < 100) {
      throw new Error('Document appears to be empty or unreadable. Please upload a text-based document.');
    }

    // Language detection (heuristic) and force model to reply in that language
    detectedLanguage = detectLanguageByStopwords(content);
    console.log('Detected language:', detectedLanguage);

    // Apply page range if requested (approx by character slices)
    let contentToUse = content;
    if (startPage || endPage) {
      const CHARS_PER_PAGE = 3000;
      const totalEstimatedPages = Math.ceil(content.length / CHARS_PER_PAGE);
      const start = Math.max(0, ((startPage || 1) - 1) * CHARS_PER_PAGE);
      const end = Math.min(content.length, (endPage || totalEstimatedPages) * CHARS_PER_PAGE);
      contentToUse = content.substring(start, end);
      console.log('Page range requested:', startPage || 1, 'to', endPage || totalEstimatedPages);
      console.log('Char range:', start, 'to', end, 'Content length:', contentToUse.length);
    }

    // Sample content if very long (same strategy you had)
    const MAX_CONTENT_SIZE = 30000;
    let sampledContent = '';
    if (contentToUse.length <= MAX_CONTENT_SIZE) {
      sampledContent = contentToUse;
    } else {
      const chunkSize = 2000;
      const numChunks = Math.floor(MAX_CONTENT_SIZE / chunkSize) || 1;
      const step = Math.floor(contentToUse.length / numChunks);
      const chunks: string[] = [];
      for (let i = 0; i < numChunks; i++) {
        const s = i * step;
        chunks.push(contentToUse.substring(s, s + chunkSize));
      }
      sampledContent = chunks.join('\n\n');
      console.log('Sampled', numChunks, 'chunks from document');
    }

    console.log('Sampled content length:', sampledContent.length);
    console.log('Sampled content preview:', sampledContent.substring(0, 300));

    const difficultyInstruction = difficulty === 'mixed'
      ? 'Create a balanced mix: some easy (basic facts), some medium (connections), some hard (analysis)'
      : `All ${difficulty} difficulty`;

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    // Few-shot examples to guide the model on difficulty and format
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

    // Function to call AI gateway (returns parsed flashcards or throws)
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

    // First attempt
    let flashcards = await callGenerateFlashcards(sampledContent);

    // Validate support of flashcards against source content: count cards where answer or question tokens appear in contentToUse
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

    let { validated, supportRate } = validateFlashcards(flashcards, contentToUse);
    console.log('Initial validation supportRate:', supportRate, 'validatedCount:', validated.length);

    // If supportRate low, retry once with stricter instruction
    if (supportRate < 0.6) {
      console.log('Support rate low (<0.6), retrying generation with stricter instruction to only include cards fully supported by SOURCE...');
      const stricterInstruction = 'IMPORTANT: Only create flashcards that are directly supported by the text above. If unsure, omit the card.';
      flashcards = await callGenerateFlashcards(sampledContent, `\n${stricterInstruction}`);
      ({ validated, supportRate } = validateFlashcards(flashcards, contentToUse));
      console.log('Post-retry validation supportRate:', supportRate, 'validatedCount:', validated.length);
    }

    // If still low, abort with helpful error rather than creating hallucinated cards
    if (supportRate < 0.5 || validated.length === 0) {
      console.error('Validation failed — insufficient supported flashcards. Support rate:', supportRate);
      throw new Error('AI-generated flashcards were not sufficiently supported by the document text. This document may be unsuitable for automatic flashcard generation. Try a text-based document, enable OCR, or edit the document to include clearer content.');
    }

    // Create flashcard set first
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
    console.log('Created flashcard set:', flashcardSet.id);

    // Insert only validated flashcards into database with set_id
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

    console.log(`Successfully created ${flashcardsToInsert.length} flashcards (validated)`);

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
