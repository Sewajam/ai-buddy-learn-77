import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Extract readable text from PDF binary data
function extractTextFromPDF(binaryContent: string): string {
  // Try to extract text between stream/endstream or BT/ET markers
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
      // Filter out obvious binary/metadata patterns
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
  // Check first 1000 chars for high ratio of non-printable chars
  const sample = content.substring(0, 1000);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // Count non-printable chars (except common whitespace)
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintable++;
    }
    if (code > 126) {
      nonPrintable++;
    }
  }
  // If more than 10% non-printable, it's likely binary
  return (nonPrintable / sample.length) > 0.1;
}

// Clean text content to remove any remaining binary artifacts
function cleanTextContent(content: string): string {
  // Remove null bytes and other control characters
  let cleaned = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ');
  // Collapse multiple spaces
  cleaned = cleaned.replace(/\s+/g, ' ');
  // Remove very short "words" that are likely artifacts
  cleaned = cleaned.replace(/\b[\w]{1,2}\b/g, ' ').replace(/\s+/g, ' ');
  return cleaned.trim();
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
      console.log('Page range requested:', startPage || 1, 'to', endPage || totalEstimatedPages);
      console.log('Char range:', start, 'to', end, 'Content length:', contentToUse.length);
    }

    console.log('Using content, length:', contentToUse.length);

    // Call Lovable AI to generate flashcards
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    // Sample content for better coverage
    const MAX_CONTENT_SIZE = 30000;
    let sampledContent = '';
    
    if (contentToUse.length <= MAX_CONTENT_SIZE) {
      sampledContent = contentToUse;
    } else {
      // Take evenly spaced chunks from the document
      const chunkSize = 2000;
      const numChunks = Math.floor(MAX_CONTENT_SIZE / chunkSize);
      const step = Math.floor(contentToUse.length / numChunks);
      const chunks: string[] = [];
      
      for (let i = 0; i < numChunks; i++) {
        const start = i * step;
        const chunk = contentToUse.substring(start, start + chunkSize);
        chunks.push(chunk);
      }
      
      sampledContent = chunks.join('\n\n');
      console.log('Sampled', numChunks, 'chunks from document');
    }
    
    console.log('Sampled content length:', sampledContent.length);
    console.log('Sampled content preview:', sampledContent.substring(0, 300));

    const difficultyInstruction = difficulty === 'mixed' 
      ? 'Create a balanced mix: some easy (basic facts), some medium (connections), some hard (analysis)'
      : `All ${difficulty} difficulty`;

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
            content: `You are creating ${count} study flashcards about the educational content provided.

RULES:
1. Create questions ONLY about facts, concepts, definitions, and information IN the provided text
2. Use direct recall questions: What is...? Define... Explain... Who... When... How...
3. Questions and answers must be in the SAME language as the source text
4. ${difficultyInstruction}
5. NEVER ask about: documents, files, systems, formats, metadata, flashcards themselves`
          },
          {
            role: 'user',
            content: `Here is the study material. Create ${count} flashcards about its educational content:\n\n${sampledContent}`
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
      throw new Error('No flashcards generated - AI did not return expected format');
    }

    console.log('Tool call arguments:', toolCall.function.arguments.substring(0, 1000));
    
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
    
    // Validate each flashcard has required fields
    for (let i = 0; i < flashcards.length; i++) {
      const card = flashcards[i];
      if (!card.question || !card.answer) {
        console.error(`Invalid flashcard at index ${i}:`, JSON.stringify(card));
        throw new Error(`Invalid flashcard format at index ${i}`);
      }
      if (!card.difficulty) {
        card.difficulty = 'medium';
      }
    }
    
    console.log(`Validated ${flashcards.length} flashcards`);

    // Create flashcard set first
    const setTitle = `${document.title} - ${difficulty === 'mixed' ? 'Mixed' : difficulty.charAt(0).toUpperCase() + difficulty.slice(1)} (${flashcards.length} cards)`;
    const { data: flashcardSet, error: setError } = await supabaseClient
      .from('flashcard_sets')
      .insert({
        user_id: user.id,
        document_id: documentId,
        title: setTitle,
        card_count: flashcards.length,
        difficulty: difficulty
      })
      .select()
      .single();

    if (setError) throw setError;
    console.log('Created flashcard set:', flashcardSet.id);

    // Insert flashcards into database with set_id
    const flashcardsToInsert = flashcards.map((card: any) => ({
      user_id: user.id,
      document_id: documentId,
      set_id: flashcardSet.id,
      question: card.question,
      answer: card.answer,
      difficulty: card.difficulty,
    }));

    const { error: insertError } = await supabaseClient
      .from('flashcards')
      .insert(flashcardsToInsert);

    if (insertError) throw insertError;

    console.log(`Successfully created ${flashcards.length} flashcards`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        count: flashcards.length,
        flashcards: flashcardsToInsert
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
