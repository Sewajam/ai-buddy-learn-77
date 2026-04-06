import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

function isBinaryContentFromBuffer(buffer: Uint8Array): boolean {
  const sample = buffer.subarray(0, Math.min(512, buffer.length));
  let nonText = 0;
  for (const byte of sample) {
    if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) nonText++;
  }
  return nonText / sample.length > 0.1;
}

function bufferToBase64(rawBuffer: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < rawBuffer.length; i += chunkSize) {
    const chunk = rawBuffer.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const formData = await req.formData();
    const file = formData.get('file') as File;
    if (!file) throw new Error('No file uploaded');

    console.info('Processing file:', file.name, 'Size:', file.size, 'Type:', file.type);

    // Extract text from the file
    const rawBuffer = new Uint8Array(await file.arrayBuffer());
    let content = '';

    const isBinary = isBinaryContentFromBuffer(rawBuffer);
    const fileName = file.name.toLowerCase();
    const isPDF = fileName.endsWith('.pdf') || file.type === 'application/pdf';
    const isImage = /\.(jpg|jpeg|png|webp)$/.test(fileName) || file.type.startsWith('image/');

    if (isPDF) {
      // Try native text extraction first
      const textDecoder = new TextDecoder('utf-8', { fatal: false });
      const rawText = textDecoder.decode(rawBuffer);
      // Look for text stream objects in PDF
      const streamMatches = rawText.match(/\(([^)]{2,})\)/g);
      if (streamMatches) {
        const candidate = streamMatches.map(m => m.slice(1, -1)).join(' ').trim();
        if (candidate.length > 200 && (candidate.match(/[a-zA-Z\u00C0-\u024F\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF]/g) || []).length > 50) {
          content = candidate;
          console.info('Used native PDF text extraction, length:', content.length);
        }
      }

      // Fallback: use AI vision for OCR
      if (!content || content.length < 200) {
        console.info('Native extraction insufficient, using AI OCR for PDF...');
        const base64 = bufferToBase64(rawBuffer);
        const extractResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
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

        if (extractResponse.ok) {
          const extractData = await extractResponse.json();
          content = extractData.choices?.[0]?.message?.content || '';
          console.info('AI OCR extraction result length:', content.length);
          if (content.length < 30) {
            console.error('AI OCR returned very little text. First 200 chars:', content.substring(0, 200));
          }
        } else {
          const errText = await extractResponse.text();
          console.error('AI OCR extraction failed:', extractResponse.status, errText);
          throw new Error('Failed to extract text from PDF. The file may be corrupted or password-protected.');
        }
      }
    } else if (isImage) {
      const base64 = bufferToBase64(rawBuffer);
      const extractResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'Extract ALL the text content from this image. Return ONLY the extracted text, preserving structure. No commentary.' },
              { type: 'image_url', image_url: { url: `data:${file.type};base64,${base64}` } }
            ]
          }],
          max_tokens: 16000,
        }),
      });

      if (extractResponse.ok) {
        const extractData = await extractResponse.json();
        content = extractData.choices?.[0]?.message?.content || '';
        console.info('Image OCR result length:', content.length);
      } else {
        const errText = await extractResponse.text();
        console.error('Image extraction failed:', errText);
        throw new Error('Failed to extract text from image');
      }
    } else if (isBinary) {
      // Try DOCX - extract text from XML
      const textDecoder = new TextDecoder('utf-8', { fatal: false });
      const rawText = textDecoder.decode(rawBuffer);
      const textMatches = rawText.match(/<w:t[^>]*>([^<]+)<\/w:t>/g);
      if (textMatches) {
        content = textMatches.map(m => m.replace(/<[^>]+>/g, '')).join(' ');
      }
      if (!content || content.length < 50) {
        // Fallback: send as binary to AI
        const base64 = bufferToBase64(rawBuffer);
        const extractResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
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
        if (extractResponse.ok) {
          const extractData = await extractResponse.json();
          content = extractData.choices?.[0]?.message?.content || '';
        }
      }
    } else {
      // Plain text
      const textDecoder = new TextDecoder('utf-8', { fatal: false });
      content = textDecoder.decode(rawBuffer);
    }

    if (!content || content.trim().length < 30) {
      console.error('Extraction failed. Content length:', content?.length || 0, 'First 100 chars:', content?.substring(0, 100));
      throw new Error('Could not extract enough text from the uploaded file. Try a different file format (TXT works best) or ensure the file contains readable text.');
    }

    // Truncate if too long
    const maxChars = 25000;
    if (content.length > maxChars) {
      content = content.substring(0, maxChars);
    }

    console.info('Extracted text length:', content.length);

    // Generate the full study kit in one call using tool calling for structured output
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
      headers: { 'Authorization': `Bearer ${LOVABLE_API_KEY}`, 'Content-Type': 'application/json' },
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
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: 'Rate limit exceeded. Please try again in a moment.' }), {
          status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: 'AI credits exhausted. Please add funds.' }), {
          status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      throw new Error('AI generation failed');
    }

    const aiData = await response.json();
    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    
    if (!toolCall?.function?.arguments) {
      throw new Error('AI did not return structured output');
    }

    const studyKit = JSON.parse(toolCall.function.arguments);

    return new Response(JSON.stringify(studyKit), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Error:', error);
    return new Response(JSON.stringify({ error: error.message || 'Unknown error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
