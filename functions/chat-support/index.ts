import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS configuration - restrict to allowed origins
const ALLOWED_ORIGINS = [
  'https://id-preview--084a84f2-56b0-4475-9a4b-1e959eeecb72.lovable.app',
  'http://localhost:5173',
  'http://localhost:8080',
];

const getCorsHeaders = (origin: string | null) => {
  const isAllowed = origin && ALLOWED_ORIGINS.some(allowed => origin === allowed || origin.endsWith('.lovable.app'));
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  };
};

// Rate limiting
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = { maxRequests: 20, windowMs: 60000 };

const checkRateLimit = (clientIP: string) => {
  const now = Date.now();
  const record = requestCounts.get(clientIP);
  
  if (!record || now > record.resetTime) {
    requestCounts.set(clientIP, { count: 1, resetTime: now + RATE_LIMIT.windowMs });
    return { allowed: true };
  }
  
  if (record.count >= RATE_LIMIT.maxRequests) {
    return { allowed: false, resetIn: record.resetTime - now };
  }
  
  record.count++;
  return { allowed: true };
};

// Input validation schema
const MessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1, "Message cannot be empty").max(4000, "Message too long"),
});

const RequestSchema = z.object({
  messages: z.array(MessageSchema).min(1, "At least one message required").max(50, "Too many messages"),
});

serve(async (req) => {
  const origin = req.headers.get('origin');
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authentication check
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: "Autenticación requerida. Por favor, inicia sesión." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify JWT using Supabase client
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace('Bearer ', '');
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims(token);
    
    if (claimsError || !claimsData?.claims) {
      console.log("Auth validation failed");
      return new Response(
        JSON.stringify({ error: "Sesión inválida. Por favor, inicia sesión de nuevo." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = claimsData.claims.sub as string;
    console.log(`Authenticated chat request from user: ${userId}`);

    // Rate limiting (now per user)
    const rateCheck = checkRateLimit(userId);
    
    if (!rateCheck.allowed) {
      return new Response(
        JSON.stringify({ error: "Demasiadas solicitudes. Por favor, espera un momento." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse and validate input
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid JSON in request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const parseResult = RequestSchema.safeParse(body);
    if (!parseResult.success) {
      console.error("Validation error:", parseResult.error.issues);
      return new Response(
        JSON.stringify({ error: "Invalid request format" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { messages } = parseResult.data;

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      console.error("LOVABLE_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "Service configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const systemPrompt = `Eres un asistente virtual experto en viajes Interrail, especializado en ayudar a jóvenes de 18-25 años a planificar su primera aventura por Europa.

Tu conocimiento incluye:
- Cómo funciona el pase Interrail y sus diferentes modalidades
- Rutas populares y recomendaciones de ciudades europeas
- Consejos de presupuesto y ahorro para viajar
- Alojamiento económico (hostels, couchsurfing, etc.)
- Transporte local y conexiones de tren
- Seguridad y consejos prácticos para viajar solo o en grupo
- Documentación necesaria y trámites
- Mejores épocas para viajar según destinos

Estilo de comunicación:
- Cercano, juvenil y motivador
- Respuestas claras y concisas
- Usa emojis ocasionalmente para hacer la conversación más amigable
- Sé práctico y directo
- Si no sabes algo específico, recomienda consultar fuentes oficiales

Objetivo: Ayudar a los usuarios a resolver dudas y animarles a planificar su viaje Interrail ideal.`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Demasiadas solicitudes, por favor intenta más tarde." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Servicio temporalmente no disponible." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      console.error("AI gateway error:", response.status);
      return new Response(JSON.stringify({ error: "Error del servicio de IA" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("Chat function error");
    return new Response(JSON.stringify({ error: "Error procesando la solicitud" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
