import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Buffer } from "node:buffer";
import pdfParse from "npm:pdf-parse@1.1.1/lib/pdf-parse.js";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

function bufferToBase64(rawBuffer: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < rawBuffer.length; i += chunkSize) {
    const chunk = rawBuffer.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function extractPdfText(rawBuffer: Uint8Array, apiKey: string): Promise<string> {
  // Try pdf-parse first
  try {
    const data = await pdfParse(Buffer.from(rawBuffer));
    const text = data.text || '';
    const letterCount = (text.match(/[a-zA-Z\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF]/g) || []).length;
    if (text.length > 500 && letterCount > 100) {
      console.info('pdf-parse extracted text, length:', text.length);
      return text;
    }
    console.info('pdf-parse result too short or low quality, falling back to AI OCR...');
  } catch (e) {
    console.warn('pdf-parse failed:', e.message);
  }

  // Fallback: AI vision OCR
  const base64 = bufferToBase64(rawBuffer);
  const resp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Extract ALL the text content from this PDF document. Return ONLY the raw extracted text, preserving structure. No commentary or explanations.' },
          { type: 'image_url', image_url: { url: `data:application/pdf;base64,${base64}` } }
        ]
      }],
      max_tokens: 16000,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error('AI OCR failed:', resp.status, errText);
    throw new Error('Failed to extract text from PDF.');
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  console.info('AI OCR extraction length:', content.length);
  return content;
}

function extractDocxText(rawBuffer: Uint8Array): string {
  const textDecoder = new TextDecoder('utf-8', { fatal: false });
  const rawText = textDecoder.decode(rawBuffer);

  // Extract text from w:t tags (Word text runs)
  const textMatches = rawText.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
  
  if (textMatches.length > 0) {
    const extracted = textMatches
      .map(match => match.replace(/<[^>]+>/g, '').trim())
      .filter(text => text.length > 0)
      .join(' ');
    
    console.info('DOCX extraction found', textMatches.length, 'text elements, total length:', extracted.length);
    return extracted;
  }

  // Fallback: try to extract any readable text between XML tags
  const fallback = rawText
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  console.info('DOCX fallback extraction length:', fallback.length);
  return fallback.length > 50 ? fallback : '';
}
  console.warn('No w:t tags found in DOCX');
  return '';
}

async function extractImageText(rawBuffer: Uint8Array, mimeType: string, apiKey: string): Promise<string> {
  const base64 = bufferToBase64(rawBuffer);
  const resp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Extract ALL the text content from this image. Return ONLY the extracted text, preserving structure. No commentary.' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
        ]
      }],
      max_tokens: 16000,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error('Image OCR failed:', errText);
    throw new Error('Failed to extract text from image.');
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || '';
  console.info('Image OCR length:', content.length);
  return content;
}

// ============================================================================
// IMPROVED: Generate study kit from a single chunk of text
// Uses the new system prompt and enforces strict JSON output
// ============================================================================
async function generateStudyKitFromText(content: string, apiKey: string): Promise<any> {
  const systemPrompt = `You are an AI Study Kit Generator. You take raw text extracted from user-uploaded files (PDF, DOCX, TXT, JPG, PNG). Your job is to return a complete, structured study kit with the following sections:

1. Summary — 5 to 10 bullet points capturing the core ideas.
2. Flashcards — at least 20 cards, each with {"front": "...", "back": "..."}.
3. Quiz — 10 questions (multiple choice + short-answer mix).
4. Mind Map — a text-based hierarchical outline showing topic relationships.
5. Practice Questions — 5 open-ended questions.
6. 7-Day Study Plan — daily tasks, concise and actionable.

Your output MUST be strict JSON in the following format ONLY. Do NOT add commentary, explanations, or text outside the JSON:
{
  "summary": ["bullet1", "bullet2", ...],
  "flashcards": [{"front": "...", "back": "..."}, ...],
  "quiz": [{"question": "...", "type": "multiple-choice|short-answer", "options": [...], "correctAnswer": "..."}, ...],
  "mindMap": "...",
  "practiceQuestions": ["question1", "question2", ...],
  "studyPlan": [{"day": 1, "focus": "...", "tasks": ["task1", "task2", ...]}, ...]
}

CRITICAL RULES:
- Return ONLY valid JSON. No preamble, no explanation, no markdown code blocks.
- All content must come DIRECTLY from the source text. Do NOT invent information.
- Use the SAME language as the source text for ALL output.
- Be thorough and cover ALL major topics from the notes.
- Flashcards minimum 20 cards.
- Quiz includes both multiple-choice and short-answer questions.
- Summary is an array of bullet points.
- studyPlan array contains 7 day objects with day number, focus area, and tasks array.`;

  const userPrompt = `Generate a complete, valid JSON study kit from these notes. Return ONLY the JSON object, no other text.

SOURCE TEXT:

${content}`;

  const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 16000,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('AI generation failed:', response.status, errText);
    if (response.status === 429) throw new Error('RATE_LIMIT');
    if (response.status === 402) throw new Error('CREDITS_EXHAUSTED');
    throw new Error('AI generation failed');
  }

  const aiData = await response.json();
  const content_text = aiData.choices?.[0]?.message?.content || '';
  
  if (!content_text) {
    throw new Error('AI did not return any content');
  }

  console.info('Raw AI response length:', content_text.length);
  console.info('First 500 chars:', content_text.substring(0, 500));

  // Extract JSON from the response (handles cases where model adds markdown or extra text)
  let jsonStr = content_text.trim();
  
  // Remove markdown code blocks if present
  if (jsonStr.startsWith('```json')) {
    jsonStr = jsonStr.replace(/^```json\n?/, '').replace(/\n?```$/, '');
  } else if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```\n?/, '').replace(/\n?```$/, '');
  }

  jsonStr = jsonStr.trim();

  // Try to parse JSON
  try {
    const parsed = JSON.parse(jsonStr);
    console.info('Successfully parsed JSON from AI response');
    return validateAndNormalizeStudyKit(parsed);
  } catch (parseError) {
    console.error('Failed to parse JSON:', parseError.message);
    console.error('Attempted to parse:', jsonStr.substring(0, 200));
    throw new Error('AI did not return valid JSON: ' + parseError.message);
  }
}

// ============================================================================
// Validate and normalize the study kit structure
// ============================================================================
function validateAndNormalizeStudyKit(kit: any): any {
  const normalized: any = {
    summary: [],
    flashcards: [],
    quiz: [],
    mindMap: '',
    practiceQuestions: [],
    studyPlan: []
  };

  // Validate and normalize summary
  if (Array.isArray(kit.summary)) {
    normalized.summary = kit.summary.filter((s: any) => s && String(s).trim().length > 0).map((s: any) => String(s).trim());
  } else if (typeof kit.summary === 'string') {
    normalized.summary = kit.summary.split('\n').filter((s: string) => s.trim().length > 0);
  }
  if (normalized.summary.length === 0) {
    throw new Error('Summary is empty or invalid');
  }

  // Validate and normalize flashcards
  if (Array.isArray(kit.flashcards)) {
    normalized.flashcards = kit.flashcards
      .filter((card: any) => card && (card.front || card.question) && (card.back || card.answer))
      .map((card: any) => ({
        front: String(card.front || card.question).trim(),
        back: String(card.back || card.answer).trim()
      }));
  }
  if (normalized.flashcards.length < 20) {
    console.warn(`Flashcards less than 20 (got ${normalized.flashcards.length}), but continuing`);
  }

  // Validate and normalize quiz
  if (Array.isArray(kit.quiz)) {
    normalized.quiz = kit.quiz
      .filter((q: any) => q && q.question && q.options && q.correctAnswer)
      .map((q: any) => ({
        question: String(q.question).trim(),
        type: q.type || 'multiple-choice',
        options: Array.isArray(q.options) ? q.options.map((o: any) => String(o).trim()) : [],
        correctAnswer: String(q.correctAnswer).trim()
      }))
      .filter((q: any) => q.options.length > 0);
  }
  if (normalized.quiz.length === 0) {
    throw new Error('Quiz is empty or invalid');
  }

  // Validate and normalize mind map
  if (typeof kit.mindMap === 'string') {
    normalized.mindMap = kit.mindMap.trim();
  } else if (typeof kit.mind_map === 'string') {
    normalized.mindMap = kit.mind_map.trim();
  }
  if (normalized.mindMap.length === 0) {
    throw new Error('Mind map is empty or invalid');
  }

  // Validate and normalize practice questions
  if (Array.isArray(kit.practiceQuestions)) {
    normalized.practiceQuestions = kit.practiceQuestions
      .filter((q: any) => q && String(q).trim().length > 0)
      .map((q: any) => String(q).trim());
  } else if (Array.isArray(kit.practice_questions)) {
    normalized.practiceQuestions = kit.practice_questions
      .filter((q: any) => q && String(q).trim().length > 0)
      .map((q: any) => String(q).trim());
  }
  if (normalized.practiceQuestions.length === 0) {
    throw new Error('Practice questions are empty or invalid');
  }

  // Validate and normalize study plan
  if (Array.isArray(kit.studyPlan)) {
    normalized.studyPlan = kit.studyPlan
      .filter((day: any) => day && day.day && day.focus)
      .map((day: any) => ({
        day: day.day,
        focus: String(day.focus).trim(),
        tasks: Array.isArray(day.tasks) ? day.tasks.map((t: any) => String(t).trim()) : []
      }));
  } else if (Array.isArray(kit.study_plan)) {
    normalized.studyPlan = kit.study_plan
      .filter((day: any) => day && day.day && day.focus)
      .map((day: any) => ({
        day: day.day,
        focus: String(day.focus).trim(),
        tasks: Array.isArray(day.tasks) ? day.tasks.map((t: any) => String(t).trim()) : []
      }));
  }
  if (normalized.studyPlan.length === 0) {
    throw new Error('Study plan is empty or invalid');
  }

  return normalized;
}

// Merge multiple study kit results from chunks
function mergeStudyKits(kits: any[]): any {
  if (kits.length === 1) return kits[0];

  return {
    summary: kits.flatMap(k => k.summary || []),
    flashcards: kits.flatMap(k => k.flashcards || []),
    quiz: kits.flatMap(k => k.quiz || []),
    mindMap: kits.map(k => k.mindMap).filter(m => m && m.length > 0).join('\n\n'),
    practiceQuestions: kits.flatMap(k => k.practiceQuestions || []),
    studyPlan: kits[0].studyPlan, // Use first chunk's plan as base since it covers the full scope
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    let notesText = '';
    const contentType = req.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      // JSON body with notesText
      const body = await req.json();
      notesText = body.notesText || '';
      if (!notesText || notesText.trim().length < 30) {
        throw new Error('notesText is too short. Please provide at least 30 characters of notes.');
      }
      console.info('Received notesText via JSON, length:', notesText.length);
    } else {
      // FormData file upload
      const formData = await req.formData();
      const file = formData.get('file') as File;
      if (!file) throw new Error('No file uploaded');

      console.info('Processing file:', file.name, 'Size:', file.size, 'Type:', file.type);

      const rawBuffer = new Uint8Array(await file.arrayBuffer());
      const fileName = file.name.toLowerCase();

      // --- File type detection and extraction ---
      if (fileName.endsWith('.pdf') || file.type === 'application/pdf') {
        notesText = await extractPdfText(rawBuffer, LOVABLE_API_KEY);
      } else if (fileName.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        notesText = extractDocxText(rawBuffer);
        if (!notesText || notesText.length < 50) {
          console.info('DOCX native extraction insufficient, using AI fallback...');
          const base64 = bufferToBase64(rawBuffer);
          const resp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'google/gemini-2.5-flash',
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: 'Extract ALL the text content from this document. Return ONLY the extracted text. No commentary.' },
                  { type: 'image_url', image_url: { url: `data:application/octet-stream;base64,${base64}` } }
                ]
              }],
              max_tokens: 16000,
            }),
          });
          if (resp.ok) {
            const data = await resp.json();
            notesText = data.choices?.[0]?.message?.content || '';
          }
        }
      } else if (fileName.endsWith('.doc')) {
        const base64 = bufferToBase64(rawBuffer);
        const resp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'google/gemini-2.5-flash',
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: 'Extract ALL the text content from this document. Return ONLY the extracted text. No commentary.' },
                { type: 'image_url', image_url: { url: `data:application/msword;base64,${base64}` } }
              ]
            }],
            max_tokens: 16000,
          }),
        });
        if (resp.ok) {
          const data = await resp.json();
          notesText = data.choices?.[0]?.message?.content || '';
        }
      } else if (fileName.endsWith('.txt') || file.type === 'text/plain') {
        const textDecoder = new TextDecoder('utf-8', { fatal: false });
        notesText = textDecoder.decode(rawBuffer);
        console.info('TXT extraction length:', notesText.length);
      } else if (/\.(jpg|jpeg|png|webp)$/.test(fileName) || file.type.startsWith('image/')) {
        notesText = await extractImageText(rawBuffer, file.type || 'image/jpeg', LOVABLE_API_KEY);
      } else {
        throw new Error('Unsupported file type. Please upload PDF, DOCX, TXT, JPG, or PNG.');
      }

      if (!notesText || notesText.trim().length < 30) {
        console.error('Extraction failed. Length:', notesText?.length || 0);
        throw new Error('Could not extract enough text from the uploaded file. Try a different file format (TXT works best) or ensure the file contains readable text.');
      }
    }

    console.info('Total extracted text length:', notesText.length);

    // --- Chunking logic ---
    const CHUNK_THRESHOLD = 15000;
    const CHUNK_SIZE = 10000;
    let studyKit: any;

    if (notesText.length > CHUNK_THRESHOLD) {
      console.info('Text exceeds threshold, splitting into chunks...');
      const chunks: string[] = [];
      for (let i = 0; i < notesText.length; i += CHUNK_SIZE) {
        chunks.push(notesText.substring(i, i + CHUNK_SIZE));
      }
      console.info(`Processing ${chunks.length} chunks...`);

      const results: any[] = [];
      for (const chunk of chunks) {
        const result = await generateStudyKitFromText(chunk, LOVABLE_API_KEY);
        results.push(result);
      }
      studyKit = mergeStudyKits(results);
    } else {
      studyKit = await generateStudyKitFromText(notesText, LOVABLE_API_KEY);
    }

    return new Response(JSON.stringify(studyKit), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Error:', error);
    if (error.message === 'RATE_LIMIT') {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please try again in a moment.' }), {
        status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (error.message === 'CREDITS_EXHAUSTED') {
      return new Response(JSON.stringify({ error: 'AI credits exhausted. Please add funds.' }), {
        status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ error: error.message || 'Unknown error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
