import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

const resend = new Resend(Deno.env.get("RESEND_API_KEY"));

// Get the app URL from environment variable (falls back to localhost for dev)
const APP_URL = Deno.env.get('APP_URL') || 'http://localhost:5173';

// CORS configuration - dynamic based on environment
const getCorsHeaders = (origin: string | null) => {
  // Allow any lovable.app subdomain and localhost for development
  const isAllowed = origin && (
    origin.endsWith('.lovable.app') || 
    origin === 'http://localhost:5173' || 
    origin === 'http://localhost:8080'
  );
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : APP_URL,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
};

// Rate limiting per email address (prevents abuse)
const emailSentCache = new Map<string, number>();
const EMAIL_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 email per address per day

const checkEmailCooldown = (email: string): { allowed: boolean; message?: string } => {
  const normalizedEmail = email.toLowerCase().trim();
  const lastSent = emailSentCache.get(normalizedEmail);
  const now = Date.now();
  
  if (lastSent && now - lastSent < EMAIL_COOLDOWN_MS) {
    const hoursRemaining = Math.ceil((EMAIL_COOLDOWN_MS - (now - lastSent)) / (60 * 60 * 1000));
    return { 
      allowed: false, 
      message: `Ya se envió un email a esta dirección. Intenta de nuevo en ${hoursRemaining} horas.` 
    };
  }
  
  return { allowed: true };
};

const markEmailSent = (email: string) => {
  emailSentCache.set(email.toLowerCase().trim(), Date.now());
};

// Input validation
const EmailSchema = z.object({
  email: z.string().email("Invalid email address").max(255, "Email too long"),
});

const handler = async (req: Request): Promise<Response> => {
  const origin = req.headers.get('origin');
  const corsHeaders = getCorsHeaders(origin);

  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
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

    const parseResult = EmailSchema.safeParse(body);
    if (!parseResult.success) {
      console.error("Validation error:", parseResult.error.issues);
      return new Response(
        JSON.stringify({ error: "Email inválido" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { email } = parseResult.data;
    const normalizedEmail = email.toLowerCase().trim();

    // Check email cooldown (rate limiting per email address)
    const cooldownCheck = checkEmailCooldown(normalizedEmail);
    if (!cooldownCheck.allowed) {
      console.log(`Email cooldown active for: ${normalizedEmail.substring(0, 3)}***`);
      return new Response(
        JSON.stringify({ error: cooldownCheck.message }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Verify email exists in database and was recently registered
    // This prevents abuse by only allowing emails that are actually in our system
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: subscriber, error: dbError } = await supabase
      .from('email_subscribers')
      .select('created_at')
      .eq('email', normalizedEmail)
      .single();

    if (dbError || !subscriber) {
      console.log(`Email not found in database or error: ${dbError?.code}`);
      return new Response(
        JSON.stringify({ error: "Email no registrado en el sistema" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Only allow sending welcome email within 10 minutes of registration
    const registeredAt = new Date(subscriber.created_at);
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    
    if (registeredAt < tenMinutesAgo) {
      console.log(`Email registration too old for: ${normalizedEmail.substring(0, 3)}***`);
      return new Response(
        JSON.stringify({ error: "El tiempo para enviar el email de bienvenida ha expirado" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("Sending welcome email to verified subscriber");

    const emailResponse = await resend.emails.send({
      from: "Interrail Planner <onboarding@resend.dev>",
      to: [normalizedEmail],
      subject: "¡Bienvenido a Interrail Planner! 🚂",
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f5;">
          <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
            <div style="background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); border-radius: 16px 16px 0 0; padding: 40px; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 28px;">🚂 Interrail Planner</h1>
            </div>
            <div style="background: white; border-radius: 0 0 16px 16px; padding: 40px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
              <h2 style="color: #18181b; margin-top: 0;">¡Bienvenido/a!</h2>
              <p style="color: #52525b; line-height: 1.6;">
                Gracias por registrarte en <strong>Interrail Planner</strong>. Estás a punto de comenzar la aventura de tu vida por Europa.
              </p>
              <p style="color: #52525b; line-height: 1.6;">
                Con nuestra plataforma podrás:
              </p>
              <ul style="color: #52525b; line-height: 1.8;">
                <li>🗺️ Explorar rutas recomendadas por expertos</li>
                <li>📅 Generar itinerarios personalizados con IA</li>
                <li>🎫 Encontrar los mejores billetes de tren</li>
                <li>🏨 Descubrir alojamientos económicos</li>
              </ul>
              <div style="text-align: center; margin-top: 30px;">
                <a href="${APP_URL}" style="display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%); color: white; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600;">
                  Comenzar a planificar
                </a>
              </div>
              <p style="color: #a1a1aa; font-size: 14px; margin-top: 30px; text-align: center;">
                ¡Buen viaje! 🌍
              </p>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    // Mark email as sent to prevent duplicates
    markEmailSent(normalizedEmail);

    console.log("Email sent successfully to verified subscriber");

    return new Response(JSON.stringify(emailResponse), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Error in send-welcome-email function");
    return new Response(
      JSON.stringify({ error: "Error al enviar el email" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
};

serve(handler);
