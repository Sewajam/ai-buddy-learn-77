import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Extract readable text from PDF binary data
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
  
  // Method 2: Extract readable ASCII sequences
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

// Check if content looks like binary/garbage
function isBinaryContent(content: string): boolean {
  const sample = content.substring(0, 1000);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintable++;
    }
    if (code > 126) {
      nonPrintable++;
    }
  }
  return (nonPrintable / sample.length) > 0.1;
}

// Clean text content
function cleanTextContent(content: string): string {
  let cleaned = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ');
  return cleaned.trim();
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { documentId, startPage, endPage } = await req.json();
    console.log('Generating quiz for document:', documentId, 'pages:', startPage, '-', endPage);

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

    // Get the document
    const { data: document, error: docError } = await supabaseClient
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .maybeSingle();

    if (docError) throw docError;
    if (!document) throw new Error('Document not found');

    // Check if document has stored content first
    let content = document.content || '';
    
    if (!content || content.length < 100) {
      // Download the file content
      const { data: fileData, error: fileError } = await supabaseClient
        .storage
        .from('documents')
        .download(document.file_path);

      if (fileError) throw fileError;

      const rawContent = await fileData.text();
      console.log('Raw file content length:', rawContent.length);
      
      // Check if content is binary (like a PDF)
      if (isBinaryContent(rawContent)) {
        console.log('Detected binary content, attempting text extraction...');
        content = extractTextFromPDF(rawContent);
        console.log('Extracted text length:', content.length);
        
        if (content.length < 100) {
          throw new Error('Could not extract readable text from this PDF. Please upload a text-based document (.txt, .md) or a PDF with selectable text.');
        }
      } else {
        content = cleanTextContent(rawContent);
      }
    }
    
    console.log('Document content length:', content.length);
    console.log('Content preview:', content.substring(0, 500));

    // Verify we have actual readable content
    if (content.length < 100) {
      throw new Error('Document appears to be empty or unreadable. Please upload a text-based document.');
    }

    // Extract page range if specified
    let contentToUse = content;
    if (startPage || endPage) {
      const CHARS_PER_PAGE = 3000;
      const totalEstimatedPages = Math.ceil(content.length / CHARS_PER_PAGE);
      const start = Math.max(0, ((startPage || 1) - 1) * CHARS_PER_PAGE);
      const end = Math.min(content.length, (endPage || totalEstimatedPages) * CHARS_PER_PAGE);
      contentToUse = content.substring(start, end);
      console.log('Page range:', startPage || 1, 'to', endPage || totalEstimatedPages);
      console.log('Char range:', start, 'to', end);
    }

    console.log('Using content length:', contentToUse.length);

    // Call Lovable AI to generate quiz
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    // Sample content if too long
    const MAX_CONTENT = 40000;
    let sampledContent = contentToUse;
    if (contentToUse.length > MAX_CONTENT) {
      const chunkSize = 3000;
      const numChunks = Math.floor(MAX_CONTENT / chunkSize);
      const step = Math.floor(contentToUse.length / numChunks);
      const chunks: string[] = [];
      
      for (let i = 0; i < numChunks; i++) {
        const start = i * step;
        chunks.push(contentToUse.substring(start, start + chunkSize));
      }
      sampledContent = chunks.join('\n\n');
      console.log('Sampled', numChunks, 'chunks from document');
    }
    
    console.log('Final content length for AI:', sampledContent.length);
    console.log('Content sample for AI:', sampledContent.substring(0, 300));

    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'system',
            content: `You are creating a 10-question multiple-choice quiz about educational content.

RULES:
1. Create questions ONLY about facts, concepts, definitions, and information IN the provided text
2. Each question must have exactly 4 options with one correct answer
3. Questions and answers must be in the SAME language as the source text
4. Focus on: key concepts, definitions, important facts, dates, names, processes
5. NEVER ask about: documents, files, formats, metadata, the quiz itself`
          },
          {
            role: 'user',
            content: `Here is the study material. Create 10 quiz questions about its educational content:\n\n${sampledContent}`
          }
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
                      question: { type: 'string', description: 'The question text' },
                      options: { 
                        type: 'array', 
                        items: { type: 'string' },
                        description: 'Array of 4 possible answers'
                      },
                      correctIndex: { 
                        type: 'number', 
                        description: 'Index of the correct answer (0-3)'
                      },
                      explanation: { type: 'string', description: 'Explanation of the correct answer' }
                    },
                    required: ['question', 'options', 'correctIndex', 'explanation']
                  },
                  minItems: 1
                }
              },
              required: ['questions']
            }
          }
        }],
        tool_choice: { type: 'function', function: { name: 'create_quiz' } }
      }),
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
      throw new Error('No quiz generated - AI did not return expected format');
    }

    console.log('Tool call arguments:', toolCall.function.arguments.substring(0, 1000));
    
    let quizData;
    try {
      quizData = JSON.parse(toolCall.function.arguments);
    } catch (parseError) {
      console.error('Failed to parse tool call arguments:', parseError);
      throw new Error('Failed to parse quiz data from AI');
    }
    
    const questions = quizData.questions || [];
    
    if (!Array.isArray(questions) || questions.length === 0) {
      console.error('No questions generated. Quiz data:', JSON.stringify(quizData));
      throw new Error('AI failed to generate quiz questions. The document content may not be suitable for quiz generation.');
    }
    
    // Validate each question has required fields
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.question || !Array.isArray(q.options) || q.options.length < 2 || typeof q.correctIndex !== 'number') {
        console.error(`Invalid question at index ${i}:`, JSON.stringify(q));
        throw new Error(`Invalid question format at index ${i}`);
      }
    }

    // Insert quiz into database
    const { data: quiz, error: insertError } = await supabaseClient
      .from('quizzes')
      .insert({
        user_id: user.id,
        document_id: documentId,
        title: `Quiz: ${document.title}`,
        questions: quizData.questions,
      })
      .select()
      .maybeSingle();

    if (insertError) throw insertError;
    if (!quiz) throw new Error('Failed to create quiz');

    console.log(`Successfully created quiz with ${quizData.questions.length} questions`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        quiz
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error generating quiz:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
