import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

const BASE = 'https://api.liteapi.travel/v3.0';

/** Minimal city → ISO country code map (European Interrail focus) */
const CITY_COUNTRY: Record<string, string> = {
  madrid: 'ES', barcelona: 'ES', sevilla: 'ES', valencia: 'ES', bilbao: 'ES', granada: 'ES',
  paris: 'FR', lyon: 'FR', marsella: 'FR', marseille: 'FR', niza: 'FR', nice: 'FR', burdeos: 'FR', bordeaux: 'FR',
  lisboa: 'PT', lisbon: 'PT', oporto: 'PT', porto: 'PT',
  roma: 'IT', rome: 'IT', milan: 'IT', 'milán': 'IT', venecia: 'IT', venice: 'IT', florencia: 'IT', florence: 'IT', napoles: 'IT', 'nápoles': 'IT', naples: 'IT', turin: 'IT', 'turín': 'IT',
  berlin: 'DE', 'berlín': 'DE', munich: 'DE', 'múnich': 'DE', hamburgo: 'DE', hamburg: 'DE', colonia: 'DE', cologne: 'DE', frankfurt: 'DE', dresde: 'DE', dresden: 'DE',
  amsterdam: 'NL', 'ámsterdam': 'NL', rotterdam: 'NL', utrecht: 'NL',
  bruselas: 'BE', brussels: 'BE', brujas: 'BE', bruges: 'BE', amberes: 'BE', antwerp: 'BE',
  viena: 'AT', vienna: 'AT', salzburgo: 'AT', salzburg: 'AT', innsbruck: 'AT',
  praga: 'CZ', prague: 'CZ', brno: 'CZ',
  budapest: 'HU', cracovia: 'PL', krakow: 'PL', varsovia: 'PL', warsaw: 'PL',
  zurich: 'CH', 'zúrich': 'CH', ginebra: 'CH', geneva: 'CH', berna: 'CH', bern: 'CH', interlaken: 'CH', lucerna: 'CH', lucerne: 'CH',
  copenhague: 'DK', copenhagen: 'DK', estocolmo: 'SE', stockholm: 'SE', oslo: 'NO', helsinki: 'FI',
  londres: 'GB', london: 'GB', edimburgo: 'GB', edinburgh: 'GB', manchester: 'GB',
  dublin: 'IE', 'dublín': 'IE',
  atenas: 'GR', athens: 'GR', tesalonica: 'GR', thessaloniki: 'GR',
  liubliana: 'SI', ljubljana: 'SI', zagreb: 'HR', split: 'HR', dubrovnik: 'HR',
  bucarest: 'RO', bucharest: 'RO', sofia: 'BG', bratislava: 'SK', tallin: 'EE', tallinn: 'EE', riga: 'LV', vilnius: 'LT',
};

const norm = (s: string) => s.trim().toLowerCase();

const countryFor = (city: string) => CITY_COUNTRY[norm(city)] ?? null;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const API_KEY = Deno.env.get('LITEAPI_SANDBOX_KEY');
    if (!API_KEY) {
      console.warn('[liteapi-hotels] LITEAPI_SANDBOX_KEY missing');
      return json({ hotels: [], fallback: true, error: 'API key not configured' });
    }

    const body = await req.json().catch(() => ({}));
    const cityName: string = String(body.cityName ?? body.city ?? '').trim();
    const checkIn: string = String(body.checkIn ?? body.checkin ?? '').trim();
    const checkOut: string = String(body.checkOut ?? body.checkout ?? '').trim();
    const adults: number = Math.min(Math.max(Number(body.adults ?? body.guests) || 1, 1), 10);
    const limit: number = Math.min(Math.max(Number(body.limit) || 6, 1), 20);
    const countryCode: string = String(body.countryCode ?? countryFor(cityName) ?? '').toUpperCase();
    const lat = Number.isFinite(Number(body.lat ?? body.latitude)) ? Number(body.lat ?? body.latitude) : null;
    const lng = Number.isFinite(Number(body.lng ?? body.longitude)) ? Number(body.lng ?? body.longitude) : null;

    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!cityName || !dateRe.test(checkIn) || !dateRe.test(checkOut)) {
      return json({ hotels: [], fallback: true, error: 'Invalid parameters (cityName, checkIn, checkOut required)' }, 400);
    }
    if (!countryCode && (lat === null || lng === null)) {
      return json({ hotels: [], fallback: true, error: `Unknown country for city "${cityName}"` });
    }

    const headers = { 'X-API-Key': API_KEY, 'Content-Type': 'application/json', accept: 'application/json' };

    // Step 1 — hotel metadata (name, photo, address): by city, then by coordinates
    const fetchHotels = async (url: string): Promise<any[]> => {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const t = await res.text();
        console.warn(`[liteapi-hotels] data/hotels ${res.status}: ${t.slice(0, 300)}`);
        return [];
      }
      const j = await res.json();
      return Array.isArray(j?.data) ? j.data : [];
    };

    let hotelList: any[] = [];
    if (countryCode) {
      hotelList = await fetchHotels(
        `${BASE}/data/hotels?countryCode=${countryCode}&cityName=${encodeURIComponent(cityName)}&limit=${limit * 4}`,
      );
    }
    // Geo fallback — funciona para cualquier ciudad del mundo
    if (!hotelList.length && lat !== null && lng !== null) {
      hotelList = await fetchHotels(
        `${BASE}/data/hotels?latitude=${lat}&longitude=${lng}&radius=15000&limit=${limit * 4}`,
      );
    }
    if (!hotelList.length) {
      return json({ hotels: [], fallback: true, error: 'No hotels found for city' });
    }

    const meta = new Map<string, any>();
    for (const h of hotelList) meta.set(String(h.id), h);
    const hotelIds = hotelList.slice(0, limit * 3).map((h) => String(h.id));

    // Step 2 — live rates for those hotels
    const nights = Math.max(
      1,
      Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000),
    );

    const ratesRes = await fetch(`${BASE}/hotels/rates`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        hotelIds,
        checkin: checkIn,
        checkout: checkOut,
        currency: 'EUR',
        guestNationality: 'ES',
        occupancies: [{ adults }],
      }),
    });

    if (!ratesRes.ok) {
      const t = await ratesRes.text();
      console.warn(`[liteapi-hotels] rates ${ratesRes.status}: ${t.slice(0, 300)}`);
      return json({ hotels: [], fallback: true, error: `LiteAPI rates error ${ratesRes.status}` });
    }

    const ratesJson = await ratesRes.json();
    const rateEntries: any[] = ratesJson?.data ?? [];

    const hotels = rateEntries
      .map((entry: any) => {
        const id = String(entry.hotelId ?? entry.hotel_id ?? '');
        const info = meta.get(id) ?? {};
        const offers: any[] = entry.roomTypes ?? entry.roomtypes ?? [];
        let best: any = null;
        let bestPrice = Infinity;
        let offerId: string | null = null;
        let roomName = '';

        for (const rt of offers) {
          const rates: any[] = rt.rates ?? [];
          for (const r of rates) {
            const amount = Number(
              r?.retailRate?.total?.[0]?.amount ??
                rt?.offerRetailRate?.amount ??
                r?.retailRate?.suggestedSellingPrice?.[0]?.amount ??
                NaN,
            );
            if (Number.isFinite(amount) && amount < bestPrice) {
              bestPrice = amount;
              best = r;
              offerId = rt.offerId ?? rt.offerid ?? null;
              roomName = r?.name ?? rt?.name ?? '';
            }
          }
        }

        if (!best || !Number.isFinite(bestPrice)) return null;

        const photo =
          info?.main_photo ?? info?.thumbnail ?? info?.hotelImages?.[0]?.url ?? '';

        return {
          id: `liteapi-${id}`,
          hotelId: id,
          offerId,
          name: info?.name ?? entry.name ?? `Hotel ${id}`,
          roomName,
          address: info?.address ?? '',
          rating: Number(info?.rating ?? info?.stars ?? 0) || 0,
          stars: Number(info?.stars ?? 0) || 0,
          imageUrl: photo,
          currency: 'EUR',
          totalPrice: Math.round(bestPrice),
          pricePerNight: Math.round(bestPrice / nights),
          boardName: best?.boardName ?? '',
          refundable: Boolean(best?.cancellationPolicies?.refundableTag === 'RFN'),
          latitude: info?.latitude ?? null,
          longitude: info?.longitude ?? null,
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => a.totalPrice - b.totalPrice)
      .slice(0, limit);

    console.log(`[liteapi-hotels] ${cityName} (${countryCode}) → ${hotels.length} hotels with rates`);

    return json({ hotels, fallback: hotels.length === 0, nights, currency: 'EUR', sandbox: true });
  } catch (e) {
    console.error('[liteapi-hotels] error', e);
    return json({ hotels: [], fallback: true, error: 'Unexpected error' });
  }
});
