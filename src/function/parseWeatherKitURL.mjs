import { Console } from "../utils/index.mjs";

// WeatherKit normally supplies a country query parameter, but native clients may
// omit it while still providing the location timezone. Keep this fallback
// intentionally narrow: UTC offsets and language alone are not reliable country
// signals, especially for zh-Hans users outside mainland China.
const TIMEZONE_COUNTRY_MAP = new Map([
    ["asia/shanghai", "CN"],
    ["asia/urumqi", "CN"],
    ["asia/chongqing", "CN"],
    ["asia/chungking", "CN"],
    ["asia/harbin", "CN"],
    ["asia/kashgar", "CN"],
    ["prc", "CN"],
    ["asia/hong_kong", "HK"],
    ["hongkong", "HK"],
    ["asia/macau", "MO"],
    ["asia/macao", "MO"],
    ["asia/taipei", "TW"],
    ["roc", "TW"],
]);

function normalizeCountry(value) {
    if (typeof value !== "string") return undefined;
    const country = value.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(country) ? country : undefined;
}

export default function parseWeatherKitURL(url = new URL($request.url)) {
    Console.debug("☑️ parseWeatherKitURL");
    const WeatherKitRegExp = /^\/api\/(?<version>v1|v2|v3)\/(availability|weather)\/(?<locale>[A-Z0-9]+(?:-[A-Z0-9]+)*)\/(?<latitude>-?\d+\.?\d*)\/(?<longitude>-?\d+\.?\d*)$/i;
    const Parameters = url?.pathname.match(WeatherKitRegExp)?.groups;
    const localeParts = Parameters?.locale?.split("-") || [];
    let localeCountry;
    // BCP 47 的末段只有两位字母时才视作地区，保留 zh-Hans 这类 script。
    if (localeParts.length > 1 && /^[A-Z]{2}$/i.test(localeParts.at(-1))) localeCountry = normalizeCountry(localeParts.pop());

    // v2 native requests commonly use `country`; the public REST API calls the
    // same ISO Alpha-2 value `countryCode`, so accept both without allowing an
    // invalid query value to suppress the safer locale/timezone fallbacks.
    const queryCountry = normalizeCountry(url?.searchParams?.get("country")) ?? normalizeCountry(url?.searchParams?.get("countryCode"));
    const timezone = url?.searchParams?.get("timezone")?.trim() || url?.searchParams?.get("timeZone")?.trim() || undefined;
    const timezoneCountry = timezone ? TIMEZONE_COUNTRY_MAP.get(timezone.toLowerCase()) : undefined;
    // `locale` controls response localization and may describe the user rather
    // than the requested coordinates. A recognized location timezone is
    // therefore a stronger fallback than the locale's region subtag.
    const country = queryCountry ?? timezoneCountry ?? localeCountry;
    const countrySource = queryCountry ? "query" : timezoneCountry ? "timezone" : localeCountry ? "locale" : "unknown";

    const result = {
        version: Parameters?.version,
        language: localeParts.join("-") || undefined,
        latitude: Parameters?.latitude,
        longitude: Parameters?.longitude,
        timezone,
        country,
        countrySource,
        dataSets: url?.searchParams?.get("dataSets")?.split(",") || [],
    };
    Console.info("✅ parseWeatherKitURL", `🟧version: ${result.version} 🟧language: ${result.language} 🟧country: ${result.country}`, `🟧latitude: ${result.latitude} 🟧longitude: ${result.longitude}`);
    return result;
}
