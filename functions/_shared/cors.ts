// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  'https://id-preview--084a84f2-56b0-4475-9a4b-1e959eeecb72.lovable.app',
  'http://localhost:5173',
  'http://localhost:8080',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8080',
];

export const getCorsHeaders = (origin: string | null) => {
  const isAllowed = origin && ALLOWED_ORIGINS.some(allowed => origin === allowed || origin.endsWith('.lovable.app'));
  
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Credentials': 'true',
  };
};

export const handleCorsPreflightRequest = (req: Request) => {
  const origin = req.headers.get('origin');
  return new Response(null, { headers: getCorsHeaders(origin) });
};
