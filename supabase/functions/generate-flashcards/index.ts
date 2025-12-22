import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.7.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

    // Download the file content
    const { data: fileData, error: fileError } = await supabaseClient
      .storage
      .from('documents')
      .download(document.file_path);

    if (fileError) throw fileError;

    const content = await fileData.text();
    console.log('Document content length:', content.length);

    // Extract page range if specified
    let contentToUse = content;
    if (startPage || endPage) {
      // Simple heuristic: split by form feed or multiple newlines as page breaks
      const pages = content.split(/\f|\n{5,}/);
      const start = startPage ? startPage - 1 : 0;
      const end = endPage ? endPage : pages.length;
      contentToUse = pages.slice(start, end).join('\n\n');
      console.log('Using pages', startPage || 1, 'to', endPage || pages.length, 'Content length:', contentToUse.length);
    }

    // We no longer perform separate language detection.
    // Instead, we tell the AI to ALWAYS keep the original document language
    // and NEVER translate the content to another language.
    console.log('Language detection skipped; using original document language.');

    // Call Lovable AI to generate flashcards
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

    // Sample random chunks from throughout the document for better coverage
    const MAX_CONTENT_SIZE = 30000;
    let sampledContent = '';
    
    if (contentToUse.length <= MAX_CONTENT_SIZE) {
      // If document is small enough, use it all
      sampledContent = contentToUse;
    } else {
      // Split content into logical sections (paragraphs or page-like chunks)
      const sections = contentToUse.split(/\n{2,}|\f/).filter(s => s.trim().length > 100);
      console.log('Total sections found:', sections.length);
      
      if (sections.length <= 10) {
        // Few sections - just take first MAX_CONTENT_SIZE chars
        sampledContent = contentToUse.substring(0, MAX_CONTENT_SIZE);
      } else {
        // Sample evenly from throughout the document (not just random)
        // Divide document into equal parts and take sections from each part
        const numSamples = Math.min(80, sections.length);
        const step = sections.length / numSamples;
        const selectedSections: string[] = [];
        let totalSize = 0;
        
        for (let i = 0; i < numSamples && totalSize < MAX_CONTENT_SIZE; i++) {
          const idx = Math.floor(i * step);
          const section = sections[idx];
          if (section && totalSize + section.length <= MAX_CONTENT_SIZE) {
            selectedSections.push(section);
            totalSize += section.length;
          }
        }
        
        // Join sections without any markers - just the raw content
        sampledContent = selectedSections.join('\n\n');
        
        console.log('Sampled', selectedSections.length, 'sections from throughout document');
      }
    }
    
    console.log('Sampled content length:', sampledContent.length);

    const difficultyInstruction = difficulty === 'mixed' 
      ? 'Mix of easy, medium, and hard questions'
      : `Focus on ${difficulty} difficulty questions`;

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
            content: `You are creating ${count} study flashcards. Difficulty: ${difficultyInstruction}.

RULES:
1. Create questions ONLY about the study material content provided - never about instructions or meta-information
2. Use direct recall questions (What is...? Define... Explain... How does...?)
3. NO multiple choice questions
4. ALL questions and answers must be in the SAME language as the study material
5. Spread questions across different topics in the material`
          },
          {
            role: 'user',
            content: `STUDY MATERIAL TO CREATE FLASHCARDS FROM (document: "${document.title}"):\n\n${sampledContent}`
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
      // Default difficulty if missing
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
