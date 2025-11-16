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

    // Call Lovable AI to generate quiz
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
            content: `You are an expert educator that creates effective assessment quizzes. Generate 10 multiple-choice questions from the provided document content. Each question should have 4 options with exactly one correct answer. Focus on testing knowledge of the actual subject matter, concepts, and facts within the content. DO NOT create meta-questions about the document itself (like "what type of document is this" or "what is the primary purpose"). Only test understanding of the learning material. CRITICAL: Generate all questions, options, and explanations in ${detectedLanguage}. Everything must be in ${detectedLanguage}.`
          },
          {
            role: 'user',
            content: `Generate a quiz from this document titled "${document.title}":\n\n${contentToUse.substring(0, 50000)}`
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
                  }
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
    
    const toolCall = aiData.choices[0].message.tool_calls?.[0];
    if (!toolCall) throw new Error('No quiz generated');

    const quizData = JSON.parse(toolCall.function.arguments);
    const questions = quizData.questions;

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
