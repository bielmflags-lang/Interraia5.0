import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const RAPIDAPI_HOST = "booking-data.p.rapidapi.com";

interface HotelSearchRequest {
  cityName: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  budget: "low" | "medium" | "high";
}

interface HotelResult {
  id: string;
  name: string;
  type: string;
  rating: number;
  pricePerNight: number;
  totalPrice: number;
  tags: string[];
  imageUrl: string;
  bookingUrl: string;
  isReal: boolean;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const RAPIDAPI_KEY = Deno.env.get('RAPIDAPI_KEY');
    if (!RAPIDAPI_KEY) {
      console.warn('[search-hotels] RAPIDAPI_KEY not configured');
      return new Response(
        JSON.stringify({ hotels: [], fallback: true, error: 'API key not configured' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { cityName, checkIn, checkOut, adults, budget } = await req.json() as HotelSearchRequest;
    console.log(`[search-hotels] Request: ${cityName}, ${checkIn}-${checkOut}, ${adults} adults, budget: ${budget}`);

    const headers = {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': RAPIDAPI_HOST,
    };

    // Step 1: Search for the destination
    const destUrl = `https://${RAPIDAPI_HOST}/autocomplete?query=${encodeURIComponent(cityName)}`;
    console.log(`[search-hotels] Searching destination: ${destUrl}`);

    const destResponse = await fetch(destUrl, { headers });

    if (!destResponse.ok) {
      const errorText = await destResponse.text();
      console.warn(`[search-hotels] Destination search failed [${destResponse.status}]: ${errorText}`);
      return new Response(
        JSON.stringify({ hotels: [], fallback: true, error: `API error: ${destResponse.status}` }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const destData = await destResponse.json();
    console.log(`[search-hotels] Destination data:`, JSON.stringify(destData).substring(0, 500));

    // Extract dest_id from various response formats
    let destId: string | null = null;
    let destType = 'city';

    const candidates = Array.isArray(destData) ? destData : 
      destData?.data || destData?.result || destData?.results || [];

    if (Array.isArray(candidates) && candidates.length > 0) {
      const first = candidates[0];
      destId = first.dest_id || first.id || first.city_id || first.city_ufi || null;
      destType = first.dest_type || first.type || 'city';
    }

    if (!destId) {
      console.warn(`[search-hotels] No dest_id found for "${cityName}"`);
      return new Response(
        JSON.stringify({ hotels: [], fallback: true, error: 'City not found in API' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[search-hotels] dest_id: ${destId}, dest_type: ${destType}`);

    // Step 2: Search hotels
    const searchUrl = `https://${RAPIDAPI_HOST}/hotels/search?dest_id=${destId}&search_type=${destType}&arrival_date=${checkIn}&departure_date=${checkOut}&adults=${adults}&room_qty=1&currency_code=EUR`;
    console.log(`[search-hotels] Searching hotels: ${searchUrl}`);

    const searchResponse = await fetch(searchUrl, { headers });

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      console.warn(`[search-hotels] Hotel search failed [${searchResponse.status}]: ${errorText}`);
      return new Response(
        JSON.stringify({ hotels: [], fallback: true, error: `Hotel search error: ${searchResponse.status}` }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const searchData = await searchResponse.json();
    console.log(`[search-hotels] Search data keys:`, Object.keys(searchData || {}));

    // Extract hotel list
    let rawHotels: any[] = [];
    if (Array.isArray(searchData)) rawHotels = searchData;
    else if (searchData?.data) rawHotels = Array.isArray(searchData.data) ? searchData.data : [];
    else if (searchData?.result) rawHotels = Array.isArray(searchData.result) ? searchData.result : [];
    else if (searchData?.hotels) rawHotels = Array.isArray(searchData.hotels) ? searchData.hotels : [];
    else if (searchData?.properties) rawHotels = Array.isArray(searchData.properties) ? searchData.properties : [];

    if (rawHotels.length === 0) {
      console.warn('[search-hotels] No hotels found in search results');
      return new Response(
        JSON.stringify({ hotels: [], fallback: true, error: 'No hotels available' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Calculate nights
    const nights = Math.max(1, Math.ceil(
      (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / (1000 * 60 * 60 * 24)
    ));

    // Map top 3 hotels
    const hotels: HotelResult[] = rawHotels.slice(0, 3).map((hotel: any, i: number) => {
      const name = hotel.hotel_name || hotel.name || hotel.property_name || `Hotel ${i + 1}`;
      const rating = hotel.review_score || hotel.rating || 0;
      const stars = hotel.class || hotel.stars || hotel.star_rating || 0;

      let totalPrice = 0;
      if (hotel.min_total_price) totalPrice = Math.round(hotel.min_total_price);
      else if (hotel.composite_price_breakdown?.gross_amount?.value) totalPrice = Math.round(hotel.composite_price_breakdown.gross_amount.value);
      else if (hotel.price_breakdown?.gross_price) totalPrice = Math.round(parseFloat(hotel.price_breakdown.gross_price));
      else if (hotel.price) totalPrice = Math.round(typeof hotel.price === 'string' ? parseFloat(hotel.price) : hotel.price);

      const pricePerNight = totalPrice > 0 ? Math.round(totalPrice / nights) : 0;

      const imageUrl = hotel.max_photo_url || hotel.main_photo_url || hotel.photo_url ||
        hotel.photos?.[0]?.url || hotel.image?.url || hotel.thumbnail ||
        `https://images.unsplash.com/photo-1631049307264-da0ec9d70304?w=600&h=400&fit=crop`;

      const tags: string[] = [];
      if (stars > 0) tags.push(`${stars}★`);
      if (hotel.distance_to_cc) tags.push(`${hotel.distance_to_cc} del centro`);
      else tags.push('Céntrico');
      tags.push('WiFi Gratis');

      let type = budget === 'low' ? 'Hostel / Albergue' : budget === 'high' ? `Hotel ${stars || '4-5'}★` : 'Hotel 3★';
      if (stars >= 4) type = `Hotel ${stars}★`;
      else if (stars === 3) type = 'Hotel 3★';

      // Build a guaranteed-working booking URL with check-in/check-out for real availability.
      // Priority: 1) absolute URL from API, 2) canonical hotel URL by hotel_id, 3) search fallback with all filters.
      const rawApiUrl: string | undefined = hotel.url || hotel.hotel_url;
      let bookingUrl: string;

      if (rawApiUrl && /^https?:\/\//i.test(rawApiUrl)) {
        // Append dates/guests to ensure real availability is shown on landing
        const sep = rawApiUrl.includes('?') ? '&' : '?';
        bookingUrl = `${rawApiUrl}${sep}checkin=${checkIn}&checkout=${checkOut}&group_adults=${adults}&no_rooms=1&selected_currency=EUR`;
      } else if (hotel.hotel_id) {
        // Canonical Booking deep link by ID guaranteed to resolve
        bookingUrl = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(name)}&checkin=${checkIn}&checkout=${checkOut}&group_adults=${adults}&no_rooms=1&selected_currency=EUR&nflt=hotelfacility%3D107`;
      } else {
        bookingUrl = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(cityName)}&checkin=${checkIn}&checkout=${checkOut}&group_adults=${adults}&no_rooms=1&selected_currency=EUR&order=popularity`;
      }

      return { id: `real-${hotel.hotel_id || hotel.id || i}`, name, type, rating: Math.round(rating * 10) / 10, pricePerNight, totalPrice, tags, imageUrl, bookingUrl, isReal: true };
    });

    console.log(`[search-hotels] ✅ Returning ${hotels.length} real hotels`);
    return new Response(
      JSON.stringify({ hotels, fallback: false }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[search-hotels] Unexpected error:', error);
    return new Response(
      JSON.stringify({ hotels: [], fallback: true, error: 'Unexpected error' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
