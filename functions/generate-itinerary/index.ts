import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS configuration - restrict to allowed origins
const getCorsHeaders = (origin: string | null) => {
  const isAllowed = origin && (
    origin.endsWith('.lovable.app') || 
    origin.endsWith('.lovableproject.com') || 
    origin === 'http://localhost:5173' || 
    origin === 'http://localhost:8080'
  );
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
};

// Rate limiting
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = { maxRequests: 5, windowMs: 60000 }; // 5 requests per minute (expensive operation)

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
const CitySchema = z.object({
  name: z.string().min(1).max(100),
  country: z.string().min(1).max(100),
});

const RequestSchema = z.object({
  startCity: z.string().min(1, "Start city required").max(100, "City name too long"),
  selectedCities: z.array(CitySchema).max(20, "Too many cities").optional(),
  days: z.number().int().min(1, "Minimum 1 day").max(90, "Maximum 90 days"),
  travelers: z.number().int().min(1, "Minimum 1 traveler").max(20, "Maximum 20 travelers"),
  budget: z.enum(['low', 'medium', 'high']),
  pace: z.enum(['slow', 'medium', 'fast', 'balanced']),
  interests: z.array(z.string().max(50)).max(10, "Too many interests").optional().default([]),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
});

serve(async (req) => {
  const origin = req.headers.get('origin');
  const corsHeaders = getCorsHeaders(origin);

  if (req.method === 'OPTIONS') {
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

    const { data: { user }, error: userError } = await supabase.auth.getUser();
    
    if (userError || !user) {
      console.log("Auth validation failed:", userError?.message);
      return new Response(
        JSON.stringify({ error: "Sesión inválida. Por favor, inicia sesión de nuevo." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = user.id;
    console.log(`Authenticated request from user: ${userId}`);

    // Rate limiting (now per user instead of just IP)
    const rateKey = userId as string;
    const rateCheck = checkRateLimit(rateKey);
    
    if (!rateCheck.allowed) {
      return new Response(
        JSON.stringify({ error: "Demasiadas solicitudes. Por favor, espera un momento antes de generar otro itinerario." }),
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
        JSON.stringify({ error: "Datos de entrada inválidos. Por favor, verifica los campos." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { startCity, selectedCities, days, travelers, budget, pace, interests, startDate, endDate } = parseResult.data;

    console.log('Generating itinerary request validated');

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      console.error("LOVABLE_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "Service configuration error" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Determinar temporada y ajuste de precios
    const tripDate = new Date(startDate);
    const month = tripDate.getMonth();
    const isHighSeason = month >= 5 && month <= 8;
    const isLowSeason = month >= 10 || month <= 2;
    const seasonMultiplier = isHighSeason ? 1.4 : isLowSeason ? 0.75 : 1.0;
    const seasonName = isHighSeason ? "alta" : isLowSeason ? "baja" : "media";

    const budgetConfig = {
      low: { hotelMin: 25, hotelMax: 50, foodMin: 15, foodMax: 30, transport: "económico" },
      medium: { hotelMin: 70, hotelMax: 120, foodMin: 30, foodMax: 60, transport: "estándar" },
      high: { hotelMin: 150, hotelMax: 300, foodMin: 60, foodMax: 120, transport: "premium" }
    };

    const config = budgetConfig[budget];
    
    const interestsText = interests && interests.length > 0 ? interests.join(", ") : "cultura general";
    const paceText = pace === "slow" ? "relajado (3-4 días por ciudad)" : 
                     pace === "fast" ? "intenso (1-2 días por ciudad)" : 
                     "equilibrado (2-3 días por ciudad)"; // "medium" and "balanced" both map to equilibrado

    const hasSelectedCities = selectedCities && selectedCities.length > 0;
    const citiesListText = hasSelectedCities 
      ? selectedCities.map((c, i) => `${i + 1}. ${c.name} (${c.country})`).join('\n')
      : `Ciudades cercanas a ${startCity}`;

const systemPrompt = `Eres un experto planificador de viajes Interrail por Europa. Genera itinerarios detallados, prácticos y realistas.

REGLA CRÍTICA SOBRE LA PRIMERA CIUDAD:
- La PRIMERA ciudad del itinerario es SIEMPRE el punto de PARTIDA (donde el viajero toma el primer tren)
- Esta primera ciudad NO necesita hotel, restaurantes ni actividades porque el viajero ya está allí
- Solo necesita el campo "isDepartureCity": true para identificarla
- El transporte de la primera ciudad está VACÍO porque es el origen
- Las demás ciudades sí necesitan toda la información completa

IMPORTANTE: Responde SIEMPRE en formato JSON válido con la siguiente estructura exacta:
{
  "cities": [
    {
      "name": "Ciudad de Partida",
      "country": "País",
      "days": 0,
      "isDepartureCity": true,
      "description": "Punto de partida del viaje",
      "highlights": [],
      "landmark": "Lugar emblemático más famoso de la ciudad (ej: Torre Eiffel, Coliseo, Big Ben)",
      "hotel": null,
      "restaurants": [],
      "transport": null,
      "activities": []
    },
    {
      "name": "Primera Ciudad a Visitar",
      "country": "País",
      "days": 2,
      "isDepartureCity": false,
      "description": "Breve descripción atractiva de la ciudad en 1-2 frases",
      "highlights": ["Punto de interés 1", "Punto de interés 2", "Punto de interés 3"],
      "landmark": "Lugar emblemático más famoso (ej: Sagrada Familia, Puerta de Brandeburgo, Coliseo)",
      "hotel": {
        "name": "Nombre del Hotel/Hostel REAL que exista",
        "pricePerNight": 80,
        "totalPrice": 160,
        "type": "Hotel 3 estrellas",
        "neighborhood": "Centro histórico",
        "description": "Breve descripción del hotel y sus características principales",
        "amenities": ["WiFi", "Desayuno", "Ubicación céntrica"]
      },
      "restaurants": [
        {
          "name": "Nombre Restaurante REAL que exista",
          "type": "Local/Tradicional",
          "priceRange": "15-25€",
          "specialty": "Especialidad del lugar",
          "description": "Breve descripción del ambiente y por qué recomendarlo",
          "cuisine": "Italiana/Francesa/Local"
        }
      ],
      "transport": {
        "from": "Ciudad de Partida",
        "type": "Tren/Avión",
        "duration": "2h 30min",
        "price": 45,
        "company": "Nombre compañía"
      },
      "activities": ["Actividad 1", "Actividad 2"]
    }
  ],
  "summary": {
    "totalDays": 7,
    "totalCities": 3,
    "totalHotelCost": 400,
    "totalFoodEstimate": 200,
    "totalTransportCost": 150,
    "totalEstimate": 750,
    "season": "alta/media/baja",
    "seasonAdjustment": "+40%/-25%/sin ajuste"
  }
}

IMPORTANTE: El campo "landmark" debe contener el nombre del monumento o lugar más emblemático y reconocible de cada ciudad (ej: Torre Eiffel para París, Coliseo para Roma, Sagrada Familia para Barcelona).`;

    const userPrompt = hasSelectedCities 
      ? `Genera un itinerario de viaje Interrail con estos parámetros:

- CIUDAD DE PARTIDA (donde se toma el primer tren, SIN hotel ni planificación): ${startCity}
- CIUDADES A VISITAR (EN ESTE ORDEN EXACTO, donde SÍ se necesita hotel):
${citiesListText}

- Duración total: ${days} días
- Número de viajeros: ${travelers}
- Presupuesto: ${budget === 'low' ? 'Económico (hostels, comida económica)' : budget === 'high' ? 'Premium (hoteles 4-5★, restaurantes de calidad)' : 'Moderado (hoteles 3★, mix de opciones)'}
- Ritmo: ${paceText}
- Intereses principales: ${interestsText}
- Fechas: del ${startDate} al ${endDate}
- Temporada: ${seasonName} (multiplicador de precios: ${seasonMultiplier})

INSTRUCCIONES CRÍTICAS:
1. La PRIMERA ciudad del array DEBE ser ${startCity} con isDepartureCity: true, days: 0, hotel: null, restaurants: [], transport: null
2. Las siguientes ciudades son las listadas arriba, en el MISMO ORDEN indicado
3. NO añadas ninguna ciudad adicional
4. Distribuye los ${days} días entre las ciudades de DESTINO (NO la de partida) según el ritmo seleccionado
5. Los precios de hotel deben estar entre ${Math.round(config.hotelMin * seasonMultiplier)}€ y ${Math.round(config.hotelMax * seasonMultiplier)}€ por noche
6. Incluye 2-3 restaurantes recomendados por ciudad con rango de precios
7. El transporte de cada ciudad debe indicar "from" la ciudad anterior
8. Las actividades deben alinearse con los intereses: ${interestsText}
9. Los precios totales son para ${travelers} viajero(s)

Genera un itinerario realista y atractivo.`
      : `Genera un itinerario de viaje Interrail con estos parámetros:

- Ciudad de partida (SIN hotel ni planificación): ${startCity}
- Duración total: ${days} días
- Número de viajeros: ${travelers}
- Presupuesto: ${budget === 'low' ? 'Económico (hostels, comida económica)' : budget === 'high' ? 'Premium (hoteles 4-5★, restaurantes de calidad)' : 'Moderado (hoteles 3★, mix de opciones)'}
- Ritmo: ${paceText}
- Intereses principales: ${interestsText}
- Fechas: del ${startDate} al ${endDate}
- Temporada: ${seasonName} (multiplicador de precios: ${seasonMultiplier})

INSTRUCCIONES CRÍTICAS:
1. La PRIMERA ciudad del array DEBE ser ${startCity} con isDepartureCity: true, days: 0, hotel: null, restaurants: [], transport: null
2. Las siguientes ciudades son destinos donde SÍ se necesita hotel y planificación
3. Los precios de hotel deben estar entre ${Math.round(config.hotelMin * seasonMultiplier)}€ y ${Math.round(config.hotelMax * seasonMultiplier)}€ por noche
4. Incluye 2-3 restaurantes recomendados por ciudad con rango de precios
5. El transporte debe ser principalmente en tren (Interrail) pero puede incluir vuelos low-cost si es más práctico
6. Las actividades deben alinearse con los intereses: ${interestsText}
7. Sugiere ciudades lógicas geográficamente conectadas desde ${startCity}
8. Los precios totales son para ${travelers} viajero(s)

Genera un itinerario realista y atractivo.`;

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
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Demasiadas solicitudes. Por favor, espera un momento." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "Se requiere pago. Por favor, añade créditos." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      console.error("AI gateway error:", response.status);
      return new Response(JSON.stringify({ error: "Error al generar el itinerario" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    
    console.log('AI response received successfully');

    let itinerary;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        itinerary = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("No JSON found in response");
      }
    } catch (parseError) {
      console.error('Error parsing AI response');
      return new Response(JSON.stringify({ error: "Error al procesar la respuesta" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ itinerary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("Error in generate-itinerary");
    return new Response(JSON.stringify({ error: "Error procesando la solicitud" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
