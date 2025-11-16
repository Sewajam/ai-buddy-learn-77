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

    // Detect document language
    const languageDetectResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('LOVABLE_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'user',
            content: `Detect the primary language of this text and respond with ONLY the language name in English (e.g., "English", "Spanish", "French", "German", etc.):\n\n${contentToUse.substring(0, 2000)}`
          }
        ]
      })
    });

    if (!languageDetectResponse.ok) {
      const errorText = await languageDetectResponse.text();
      console.error('Language detection error:', languageDetectResponse.status, errorText);
      throw new Error(`AI service temporarily unavailable. Please try again in a moment.`);
    }

    const langData = await languageDetectResponse.json();
    const detectedLanguage = langData.choices[0].message.content.trim();
    console.log('Detected language:', detectedLanguage);

    // Call Lovable AI to generate flashcards
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) throw new Error('LOVABLE_API_KEY not configured');

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
            content: `You are an expert educator that creates effective study flashcards. Generate ${count} flashcards from the provided document content. ${difficulty === 'mixed' ? 'Use a mix of easy, medium, and hard difficulties.' : `Focus on ${difficulty} difficulty level.`} Focus on key concepts, definitions, and important facts from the CONTENT itself. DO NOT create questions about the document type, format, or meta-information (like "what is this document about" or "what kind of file is this"). Only create questions that test understanding of the actual subject matter and learning material within the document. CRITICAL: Generate all flashcards in ${detectedLanguage}. The questions AND answers must be in ${detectedLanguage}.`
          },
          {
            role: 'user',
            content: `Generate flashcards from this document titled "${document.title}":\n\n${contentToUse.substring(0, 50000)}`
          }
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'create_flashcards',
            description: 'Create a set of flashcards from document content',
            parameters: {
              type: 'object',
              properties: {
                flashcards: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      question: { type: 'string', description: 'The question or prompt' },
                      answer: { type: 'string', description: 'The answer or explanation' },
                      difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] }
                    },
                    required: ['question', 'answer', 'difficulty']
                  }
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
    
    const toolCall = aiData.choices[0].message.tool_calls?.[0];
    if (!toolCall) throw new Error('No flashcards generated');

    const flashcardsData = JSON.parse(toolCall.function.arguments);
    const flashcards = flashcardsData.flashcards;

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
