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
  // DOCX files are ZIP archives containing XML. Extract text from w:t tags.
  const textDecoder = new TextDecoder('utf-8', { fatal: false });
  const rawText = textDecoder.decode(rawBuffer);

  // Find the word/document.xml content within the ZIP
  const textMatches = rawText.match(/<w:t[^>]*>([^<]*)<\/w:t>/g);
  if (textMatches && textMatches.length > 0) {
    // Group text by paragraphs using w:p markers
    const paragraphs: string[] = [];
    let current = '';

    // Split by paragraph markers and collect text
    const parts = rawText.split(/<w:p[ >]/);
    for (const part of parts) {
      const tMatches = part.match(/<w:t[^>]*>([^<]*)<\/w:t>/g);
      if (tMatches) {
        const line = tMatches.map(m => m.replace(/<[^>]+>/g, '')).join('');
        if (line.trim()) paragraphs.push(line);
      }
    }

    const result = paragraphs.join('\n');
    console.info('DOCX extraction length:', result.length);
    return result;
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

// Generate study kit from a single chunk of text
async function generateStudyKitFromText(content: string, apiKey: string): Promise<any> {
  const systemPrompt = `You are an expert study assistant. Given student notes, you generate a comprehensive study kit. 

CRITICAL RULES:
- ALL content must come DIRECTLY from the source text. Do NOT invent information.
- Use the SAME language as the source text for ALL output.
- Be thorough and cover ALL major topics from the notes.`;

  const userPrompt = `Generate a complete study kit from these notes. Return structured output with these sections:

1. SUMMARY: A clear, comprehensive summary of the key concepts (3-5 paragraphs)
2. FLASHCARDS: 10-15 question/answer pairs covering key facts and concepts  
3. QUIZ: 8-10 multiple choice questions with 4 options each and the correct answer letter
4. MINDMAP: A hierarchical bullet-point outline showing how topics relate
5. PRACTICE QUESTIONS: 5-8 open-ended/free-response questions for deeper thinking
6. STUDY PLAN: A 7-day study plan breaking the material into daily focus areas

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
      tools: [{
        type: 'function',
        function: {
          name: 'create_study_kit',
          description: 'Create a structured study kit from notes',
          parameters: {
            type: 'object',
            properties: {
              summary: { type: 'string', description: 'Comprehensive summary of the notes (3-5 paragraphs)' },
              flashcards: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    question: { type: 'string' },
                    answer: { type: 'string' }
                  },
                  required: ['question', 'answer']
                }
              },
              quiz: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    question: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } },
                    answer: { type: 'string', description: 'The correct option letter (A, B, C, or D)' }
                  },
                  required: ['question', 'options', 'answer']
                }
              },
              mindmap: { type: 'string', description: 'Hierarchical bullet-point outline using indentation' },
              practice_questions: {
                type: 'array',
                items: { type: 'string' }
              },
              study_plan: { type: 'string', description: '7-day study plan with daily focus areas' }
            },
            required: ['summary', 'flashcards', 'quiz', 'mindmap', 'practice_questions', 'study_plan']
          }
        }
      }],
      tool_choice: { type: 'function', function: { name: 'create_study_kit' } },
      max_tokens: 12000,
      temperature: 0.2,
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
  const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall?.function?.arguments) throw new Error('AI did not return structured output');
  return JSON.parse(toolCall.function.arguments);
}

// Merge multiple study kit results from chunks
function mergeStudyKits(kits: any[]): any {
  if (kits.length === 1) return kits[0];

  return {
    summary: kits.map(k => k.summary).join('\n\n'),
    flashcards: kits.flatMap(k => k.flashcards || []),
    quiz: kits.flatMap(k => k.quiz || []),
    mindmap: kits.map(k => k.mindmap).join('\n\n'),
    practice_questions: kits.flatMap(k => k.practice_questions || []),
    study_plan: kits[0].study_plan, // Use first chunk's plan as base since it covers the full scope
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    const formData = await req.formData();
    const file = formData.get('file') as File;
    if (!file) throw new Error('No file uploaded');

    console.info('Processing file:', file.name, 'Size:', file.size, 'Type:', file.type);

    const rawBuffer = new Uint8Array(await file.arrayBuffer());
    const fileName = file.name.toLowerCase();
    let notesText = '';

    // --- File type detection and extraction ---
    if (fileName.endsWith('.pdf') || file.type === 'application/pdf') {
      notesText = await extractPdfText(rawBuffer, LOVABLE_API_KEY);
    } else if (fileName.endsWith('.docx') || file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      notesText = extractDocxText(rawBuffer);
      // If DOCX extraction fails, try AI fallback
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
      // Legacy .doc - use AI fallback
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
