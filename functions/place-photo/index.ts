import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

// Server-side calls must use an UNRESTRICTED (or IP-restricted) key.
// Browser keys restricted by HTTP referrer return 403 API_KEY_HTTP_REFERRER_BLOCKED.
const KEY_CANDIDATES: { name: string; value: string }[] = [
  { name: "GOOGLE_PLACES_SERVER_KEY", value: Deno.env.get("GOOGLE_PLACES_SERVER_KEY") ?? "" },
  { name: "GOOGLE_MAPS_API_KEY", value: Deno.env.get("GOOGLE_MAPS_API_KEY") ?? "" },
  { name: "GOOGLE_API_KEY", value: Deno.env.get("GOOGLE_API_KEY") ?? "" },
].filter((k) => k.value.length > 0);

// In-memory cache (per isolate) to keep quota usage low
const cache = new Map<string, string | null>();
let lastStatus = "";
// Remembers which key actually works so we don't retry blocked keys every call
let workingKey: string | null = null;

interface PoiRequest {
  name: string;
  lat?: number;
  lng?: number;
  city?: string;
  country?: string;
  /** "lodging" for hotels/hostels/guest houses, "restaurant" for food, "city" for covers */
  type?: string;
}

// Google Places (New) primary types accepted for accommodation searches
const LODGING_TYPES = [
  "hotel",
  "resort_hotel",
  "bed_and_breakfast",
  "guest_house",
  "hostel",
  "motel",
  "lodging",
];

const CITY_TYPES = ["city", "locality", "destination", "ciudad"];

function isCityRequest(type?: string): boolean {
  return !!type && CITY_TYPES.includes(type.toLowerCase().trim());
}

function normalizeIncludedType(type?: string): string | undefined {
  if (!type) return undefined;
  const t = type.toLowerCase().trim();
  if (LODGING_TYPES.includes(t)) return t === "lodging" ? "hotel" : t;
  if (t === "accommodation" || t === "alojamiento") return "hotel";
  if (t === "restaurant" || t === "food") return "restaurant";
  return undefined;
}

interface SearchOutcome {
  photoName?: string;
  placeId?: string;
  status: number;
  raw: unknown;
  keyName: string;
  keyValue: string;
}

async function searchPlace(
  query: string,
  poi: PoiRequest,
  includedType?: string,
): Promise<SearchOutcome | null> {
  const body: Record<string, unknown> = {
    textQuery: query,
    maxResultCount: 1,
    languageCode: "es",
  };
  if (includedType) body.includedType = includedType;
  if (typeof poi.lat === "number" && typeof poi.lng === "number") {
    body.locationBias = {
      circle: { center: { latitude: poi.lat, longitude: poi.lng }, radius: 5000 },
    };
  }

  const keys = workingKey
    ? KEY_CANDIDATES.filter((k) => k.name === workingKey).concat(
        KEY_CANDIDATES.filter((k) => k.name !== workingKey),
      )
    : KEY_CANDIDATES;


  let last: SearchOutcome | null = null;

  for (const key of keys) {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key.value,
        "X-Goog-FieldMask": "places.id,places.displayName,places.photos,places.location",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));

    console.log(
      `[place-photo] searchText poi="${poi.name}" query="${query}" key=${key.name} status=${res.status} ` +
        `results=${Array.isArray((data as any)?.places) ? (data as any).places.length : 0} ` +
        `error=${(data as any)?.error?.message ?? "none"}`,
    );

    last = {
      photoName: (data as any)?.places?.[0]?.photos?.[0]?.name,
      placeId: (data as any)?.places?.[0]?.id,
      status: res.status,
      raw: data,
      keyName: key.name,
      keyValue: key.value,
    };

    if (res.ok) {
      workingKey = key.name;
      return last;
    }
    // 403 / 400 -> try the next configured key
    lastStatus = `searchText ${res.status} key=${key.name} ${JSON.stringify(data).slice(0, 300)}`;
  }

  return last;
}

async function resolvePhoto(poi: PoiRequest): Promise<string | null> {
  const cacheKey = `${poi.name}|${poi.city ?? ""}|${poi.country ?? ""}|${poi.type ?? ""}|${poi.lat ?? ""},${poi.lng ?? ""}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null;

  try {
    const cityRequest = isCityRequest(poi.type);
    const includedType = cityRequest ? undefined : normalizeIncludedType(poi.type);

    // City covers: force Google to return an iconic/panoramic shot of that exact city.
    // Other POIs: always bias the text query with the city so they resolve exactly.
    const query = cityRequest
      ? `${poi.name}${poi.country ? `, ${poi.country}` : ""} skyline panorama landmark`
      : poi.city
        ? `${poi.name}, ${poi.city}`
        : poi.name;

    // 1) enriched query (city cover) / name + city + place type (lodging/restaurant)
    let outcome = await searchPlace(query, poi, includedType);

    if (cityRequest && outcome && !outcome.photoName) {
      console.warn(
        `[place-photo][city] no photos in first result for "${poi.name}" country="${poi.country ?? "?"}" ` +
          `query="${query}" status=${outcome.status} key=${outcome.keyName} ` +
          `response=${JSON.stringify(outcome.raw).slice(0, 1500)}`,
      );
      // 1b) iconic landmark query
      const landmarkQuery = `${poi.name}${poi.country ? `, ${poi.country}` : ""} famous landmark city center`;
      const retry = await searchPlace(landmarkQuery, poi);
      if (retry?.photoName || retry?.placeId) outcome = retry;
      if (!retry?.photoName) {
        console.warn(
          `[place-photo][city] landmark retry empty for "${poi.name}" query="${landmarkQuery}" ` +
            `status=${retry?.status ?? "n/a"} response=${JSON.stringify(retry?.raw ?? {}).slice(0, 1500)}`,
        );
      }
      // 1c) plain city name as last resort
      if (!outcome?.photoName && !outcome?.placeId) {
        const plain = await searchPlace(
          poi.country ? `${poi.name}, ${poi.country}` : poi.name,
          poi,
        );
        if (plain) outcome = plain;
      }
    }

    // 2) same query without the type restriction
    if (includedType && outcome && !outcome.photoName && !outcome.placeId) {
      outcome = await searchPlace(query, poi);
    }

    // 3) Retry without the city if the combined query found nothing
    if (!cityRequest && outcome && !outcome.photoName && !outcome.placeId && poi.city) {
      outcome = await searchPlace(poi.name, poi);
    }


    if (!outcome) {
      cache.set(cacheKey, null);
      return null;
    }

    let photoName = outcome.photoName;

    // Some places don't return photos in Text Search -> fall back to Place Details
    if (!photoName && outcome.placeId) {
      const detailsRes = await fetch(
        `https://places.googleapis.com/v1/places/${outcome.placeId}`,
        {
          headers: {
            "X-Goog-Api-Key": outcome.keyValue,
            "X-Goog-FieldMask": "photos",
          },
        },
      );
      const details = await detailsRes.json().catch(() => ({}));
      photoName = (details as any)?.photos?.[0]?.name;
      console.log(
        `[place-photo] details poi="${poi.name}" status=${detailsRes.status} photo=${photoName ?? "none"} ` +
          `error=${(details as any)?.error?.message ?? "none"}`,
      );
      if (!photoName) {
        lastStatus = `details ${detailsRes.status} ${JSON.stringify(details).slice(0, 300)}`;
      }
    }

    if (!photoName) {
      lastStatus ||= `searchText ${outcome.status} ${JSON.stringify(outcome.raw).slice(0, 300)}`;
      console.warn(`[place-photo] no photo found for "${poi.name}" -> ${lastStatus}`);
      cache.set(cacheKey, null);
      return null;
    }

    // Photo media: skipHttpRedirect returns JSON with a public photoUri
    // (googleusercontent URL, contains no API key -> safe for the browser).
    const mediaRes = await fetch(
      `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=800&maxWidthPx=800&skipHttpRedirect=true&key=${outcome.keyValue}`,
    );
    const media = await mediaRes.json().catch(() => ({}));
    const uri: string | null = (media as any)?.photoUri ?? null;
    console.log(
      `[place-photo] media poi="${poi.name}" status=${mediaRes.status} uri=${uri ? "ok" : "empty"} ` +
        `error=${(media as any)?.error?.message ?? "none"}`,
    );
    if (!uri) lastStatus = `media ${mediaRes.status} ${(media as any)?.error?.message ?? ""}`;

    cache.set(cacheKey, uri);
    return uri;
  } catch (err) {
    console.error("place-photo error", poi.name, err);
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (KEY_CANDIDATES.length === 0) {
    return json({ error: "No Google API key configured", photos: {} }, 500);
  }

  try {
    const body = await req.json().catch(() => null);
    const rawPois = Array.isArray(body?.pois) ? body.pois : [];

    const pois: PoiRequest[] = rawPois
      .filter((p: unknown) => p && typeof (p as PoiRequest).name === "string")
      .slice(0, 20)
      .map((p: PoiRequest) => ({
        name: String(p.name).trim().slice(0, 120),
        city: typeof p.city === "string" ? p.city.trim().slice(0, 80) : undefined,
        country: typeof p.country === "string" ? p.country.trim().slice(0, 80) : undefined,
        lat: typeof p.lat === "number" ? p.lat : undefined,
        lng: typeof p.lng === "number" ? p.lng : undefined,
        type: typeof p.type === "string" ? p.type.trim().slice(0, 40) : undefined,

      }))
      .filter((p: PoiRequest) => p.name.length > 0);

    if (pois.length === 0) {
      return json({ error: "pois array is required" }, 400);
    }

    console.log(`[place-photo] request for ${pois.length} pois:`, pois.map((p) => p.name).join(", "));

    const results = await Promise.all(pois.map((p) => resolvePhoto(p)));
    const photos: Record<string, string> = {};
    pois.forEach((p, i) => {
      const url = results[i];
      if (url) photos[p.name] = url;
    });

    console.log(`[place-photo] resolved ${Object.keys(photos).length}/${pois.length} photos`);

    const url = new URL(req.url);
    if (url.searchParams.get("debug") === "1") {
      return json({ photos, debug: lastStatus, keys: KEY_CANDIDATES.map((k) => k.name), workingKey });
    }
    return json({ photos });
  } catch (err) {
    console.error("place-photo fatal", err);
    return json({ photos: {} }, 200);
  }
});
