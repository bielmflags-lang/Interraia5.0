// Simple in-memory rate limiting (resets on function cold start)
// For production, consider using Redis or Supabase table
const requestCounts = new Map<string, { count: number; resetTime: number }>();

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export const checkRateLimit = (
  clientIP: string,
  config: RateLimitConfig = { maxRequests: 10, windowMs: 60000 }
): { allowed: boolean; remaining: number; resetIn: number } => {
  const now = Date.now();
  const key = clientIP;
  
  const record = requestCounts.get(key);
  
  if (!record || now > record.resetTime) {
    // New window
    requestCounts.set(key, { count: 1, resetTime: now + config.windowMs });
    return { allowed: true, remaining: config.maxRequests - 1, resetIn: config.windowMs };
  }
  
  if (record.count >= config.maxRequests) {
    return { 
      allowed: false, 
      remaining: 0, 
      resetIn: record.resetTime - now 
    };
  }
  
  record.count++;
  return { 
    allowed: true, 
    remaining: config.maxRequests - record.count, 
    resetIn: record.resetTime - now 
  };
};

export const getClientIP = (req: Request): string => {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 
         req.headers.get('cf-connecting-ip') || 
         'unknown';
};
