/**
 * WeatherKit weather-alert helpers adapted from NSRingo/WeatherKit v3.2.0.
 *
 * The proxy only needs coordinate-based alert details, so the upstream legacy
 * QWeather HTML scraper is intentionally not included here.
 */
export default class WeatherAlerts {
    /** Resolve weather-alert enrichment to an explicitly supported provider. */
    static ResolveProvider(settings) {
        switch (settings?.WeatherAlerts?.Provider) {
            case "ColorfulClouds":
            case "QWeather":
                return settings.WeatherAlerts.Provider;
            case "WeatherKit":
                return "WeatherKit";
            case undefined:
            case null:
            case "":
                return "QWeather";
            default:
                return "WeatherKit";
        }
    }

    /** QWeather has an upstream public Key; Caiyun CAP requires an explicit authorized token. */
    static CanUseProvider(settings, providerName = WeatherAlerts.ResolveProvider(settings)) {
        switch (providerName) {
            case "ColorfulClouds":
                return String(settings?.API?.ColorfulClouds?.Token ?? "").trim().length > 0;
            case "QWeather":
                return true;
            default:
                return false;
        }
    }

    static ParseCoordinateIdentifier(ids) {
        const match = String(ids ?? "")
            .trim()
            .match(/^(?<latitude>-?\d+(?:\.\d+)?),(?<longitude>-?\d+(?:\.\d+)?)$/);
        if (!match?.groups) return null;

        const latitude = Number(match.groups.latitude);
        const longitude = Number(match.groups.longitude);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
        return {
            latitude: match.groups.latitude,
            longitude: match.groups.longitude,
        };
    }

    /**
     * Fill missing or generic fields in matching Apple summaries. Established
     * Apple values and per-alert URLs stay authoritative, and no alert is added.
     */
    static mergeAlerts(target = [], source = []) {
        if (!Array.isArray(target) || !Array.isArray(source) || !target.length || !source.length) return target;

        const usedSourceIndexes = new Set();
        for (let targetIndex = 0; targetIndex < target.length; targetIndex++) {
            const targetAlert = target[targetIndex];
            const sourceIndex = WeatherAlerts.#FindSourceAlert(targetAlert, source, usedSourceIndexes, targetIndex);
            if (!targetAlert || sourceIndex < 0 || !source[sourceIndex]) continue;
            usedSourceIndexes.add(sourceIndex);
            WeatherAlerts.#FillAlert(targetAlert, source[sourceIndex]);
        }
        return target;
    }

    /** Build the JSON array consumed by Apple's /api/v1/weatherAlerts page. */
    static Build(extracted, context) {
        const alerts = Array.isArray(extracted?.alerts) ? extracted.alerts : [];
        const identifier = String(context?.identifier ?? "");
        const contextAreaId = identifier.match(/-(\d+)$/)?.[1];
        const attributionURL = String(context?.attributionUrl ?? "");

        return alerts.map((alert, precedence) => {
            const uid = WeatherAlerts.#StableUUID(`${identifier}:${alert.identifier ?? precedence}`);
            const messages = [];
            if (alert.warningLevel) {
                messages.push({
                    language: context.language,
                    text: alert.warningLevel,
                    title: WeatherAlerts.#WarningLevelTitle(context.language),
                });
            }
            for (const text of [alert.message, alert.standard, alert.guidelines?.filter(Boolean).join("\n")]) {
                if (text) messages.push({ language: context.language, text });
            }
            if (!messages.length && alert.description) messages.push({ language: context.language, text: alert.description });

            const responses = WeatherAlerts.#BuildResponses(alert.guidelines, alert.responses);
            const areaId = alert.areaId || contextAreaId;
            const areaName = alert.areaName || extracted?.areaName;
            const effectiveTime = alert.effectiveTime ?? alert.issuedTime;
            const expireTime = alert.expireTime ?? "9999-12-31T23:59:59Z";
            const eventOnsetTime = alert.eventOnsetTime ?? effectiveTime;
            const eventEndTime = alert.eventEndTime ?? (alert.expireTime ? expireTime : undefined);
            const source = alert.source || extracted?.source || "QWeather";
            const importance = alert.importance || WeatherAlerts.#ImportanceFromSeverity(alert.severity);

            return {
                id: uid,
                ...(areaId ? { areaId } : {}),
                ...(areaName ? { areaName } : {}),
                attributionURL,
                certainty: alert.certainty || "unknown",
                countryCode: context.countryCode ?? "",
                description: alert.description,
                detailsUrl: `#${uid}`,
                effectiveTime,
                ...(eventEndTime ? { eventEndTime } : {}),
                ...(eventOnsetTime ? { eventOnsetTime } : {}),
                eventSource: context.eventSource ?? "CN",
                expireTime,
                issuedTime: alert.issuedTime,
                ...(importance ? { importance } : {}),
                messages,
                name: "WeatherAlert",
                ...(alert.phenomenon ? { phenomenon: alert.phenomenon } : {}),
                precedence,
                responses,
                ...(alert.significance ? { significance: alert.significance } : {}),
                reportedAt: alert.reportedAt,
                severity: alert.severity,
                source,
                ...(alert.token ? { token: alert.token } : {}),
                urgency: alert.urgency || "unknown",
            };
        });
    }

    static #FillAlert(target, source) {
        WeatherAlerts.#FillText(target, "areaId", source.areaId);
        WeatherAlerts.#FillText(target, "areaName", source.areaName);
        WeatherAlerts.#FillTime(target, "effectiveTime", source.effectiveTime ?? source.issuedTime);
        WeatherAlerts.#FillTime(target, "eventOnsetTime", source.eventOnsetTime ?? source.effectiveTime ?? source.issuedTime ?? target.effectiveTime ?? target.issuedTime);
        WeatherAlerts.#FillTime(target, "eventEndTime", source.eventEndTime ?? source.expireTime ?? target.expireTime);
        WeatherAlerts.#FillTime(target, "expireTime", source.expireTime ?? source.eventEndTime);
        WeatherAlerts.#FillTime(target, "issuedTime", source.issuedTime ?? source.effectiveTime);
        WeatherAlerts.#FillDescription(target, source);
        WeatherAlerts.#FillText(target, "source", source.source);
        WeatherAlerts.#FillEnum(target, "phenomenon", source.phenomenon);
        WeatherAlerts.#FillText(target, "token", source.token);
        WeatherAlerts.#FillResponses(target, source);
        WeatherAlerts.#FillFlatBufferEnum(target, "severity", source.severity, ["UNKNOWN"]);
        WeatherAlerts.#FillFlatBufferEnum(target, "certainty", source.certainty);
        WeatherAlerts.#FillFlatBufferEnum(target, "importance", source.importance || WeatherAlerts.#ImportanceFromSeverity(source.severity));
        WeatherAlerts.#FillFlatBufferEnum(target, "significance", source.significance);
        WeatherAlerts.#FillFlatBufferEnum(target, "urgency", source.urgency);
    }

    static #FillText(target, key, sourceValue) {
        if (String(target?.[key] ?? "").trim()) return;
        const value = String(sourceValue ?? "").trim();
        if (value) target[key] = value;
    }

    static #FillDescription(target, source) {
        const current = String(target?.description ?? "").trim();
        const value = String(source?.description ?? "").trim();
        if (!value) return;
        const currentKey = WeatherAlerts.#NormalizeMatchText(current);
        const phenomenonKey = WeatherAlerts.#NormalizeMatchText(source?.phenomenon);
        if (!currentKey || currentKey === phenomenonKey || currentKey === "other" || currentKey === "unknown") target.description = value;
    }

    static #FillEnum(target, key, sourceValue, fallbackValues = ["unknown", "Other"]) {
        const current = String(target?.[key] ?? "").trim();
        const isFallback = fallbackValues.some(value => current.toLowerCase() === String(value).toLowerCase());
        if (current && !isFallback) return;
        const value = String(sourceValue ?? "").trim();
        if (value) target[key] = value;
    }

    static #FillFlatBufferEnum(target, key, sourceValue, fallbackValues = ["UNKNOWN"]) {
        const value = WeatherAlerts.#FlatBufferEnum(key, sourceValue);
        if (value) WeatherAlerts.#FillEnum(target, key, value, fallbackValues);
    }

    static #FillTime(target, key, sourceValue) {
        if (target?.[key]) return;
        const value = WeatherAlerts.#ToUnixSeconds(sourceValue);
        if (value !== undefined) target[key] = value;
    }

    static #FillResponses(target, source) {
        if (Array.isArray(target?.responses) && target.responses.length) return;
        const responses = WeatherAlerts.#BuildFlatBufferResponses(source.guidelines, source.responses);
        if (responses.length) target.responses = responses;
    }

    static #FindSourceAlert(target, source, usedIndexes, targetIndex) {
        let bestIndex = -1;
        let bestScore = 0;
        for (let index = 0; index < source.length; index++) {
            if (usedIndexes.has(index)) continue;
            const score = WeatherAlerts.#ScoreAlert(target, source[index]);
            if (score > bestScore) {
                bestScore = score;
                bestIndex = index;
            }
        }
        if (bestScore >= 30) return bestIndex;
        if (targetIndex < source.length && !usedIndexes.has(targetIndex)) return targetIndex;
        return -1;
    }

    static #ScoreAlert(target, source) {
        let score = 0;
        const targetAreaId = WeatherAlerts.#NormalizeMatchText(target?.areaId);
        const sourceAreaId = WeatherAlerts.#NormalizeMatchText(source?.areaId);
        const targetAreaName = WeatherAlerts.#NormalizeMatchText(target?.areaName);
        const sourceAreaName = WeatherAlerts.#NormalizeMatchText(source?.areaName);
        const targetToken = WeatherAlerts.#NormalizeMatchText(target?.token);
        const sourceToken = WeatherAlerts.#NormalizeMatchText(source?.token);
        const targetDescription = WeatherAlerts.#NormalizeMatchText(target?.description);
        const sourceDescription = WeatherAlerts.#NormalizeMatchText(source?.description);
        const sourceMessage = WeatherAlerts.#NormalizeMatchText(source?.message);
        const targetPhenomenon = WeatherAlerts.#NormalizeMatchText(target?.phenomenon);
        const sourcePhenomenon = WeatherAlerts.#NormalizeMatchText(source?.phenomenon);
        const targetSeverity = WeatherAlerts.#NormalizeMatchText(target?.severity);
        const sourceSeverity = WeatherAlerts.#NormalizeMatchText(source?.severity);

        if (targetAreaId && sourceAreaId && targetAreaId === sourceAreaId) score += 60;
        if (targetAreaName && sourceAreaName && targetAreaName === sourceAreaName) score += 40;
        if (targetToken && sourceToken && targetToken === sourceToken) score += 50;
        if (targetDescription && sourcePhenomenon && targetDescription === sourcePhenomenon) score += 50;
        if (targetDescription && sourceDescription && sourceDescription.includes(targetDescription)) score += 40;
        if (targetDescription && sourceMessage && sourceMessage.includes(targetDescription)) score += 30;
        if (targetPhenomenon && sourcePhenomenon && (targetPhenomenon === sourcePhenomenon || sourcePhenomenon.includes(targetPhenomenon))) score += 30;
        if (targetSeverity && sourceSeverity && targetSeverity === sourceSeverity && targetSeverity !== "unknown") score += 10;
        return score;
    }

    static #NormalizeMatchText(value) {
        return String(value ?? "")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "")
            .replace(/预警信号|预警|警报|报告/g, "");
    }

    static #ToUnixSeconds(value) {
        if (value == null || value === "") return undefined;
        if (typeof value === "number") return value;
        const time = new Date(value).getTime();
        return Number.isNaN(time) ? undefined : Math.trunc(time / 1000);
    }

    static #ImportanceFromSeverity(severity) {
        switch (
            String(severity ?? "")
                .trim()
                .toLowerCase()
        ) {
            case "extreme":
            case "severe":
                return "high";
            case "minor":
                return "low";
            case "moderate":
            default:
                return "normal";
        }
    }

    static #WarningLevelTitle(language) {
        const normalized = String(language ?? "").toLowerCase();
        if (normalized.startsWith("zh") && /(?:hant|tw|hk|mo)/.test(normalized)) return "預警等級";
        if (normalized.startsWith("zh")) return "预警等级";
        return "Warning level";
    }

    static #BuildResponses(guidelines, preferredResponses = []) {
        const preferred = [];
        for (const response of preferredResponses ?? []) {
            const token = String(response ?? "").trim();
            if (token && !preferred.includes(token)) preferred.push(token);
        }
        if (preferred.length) return preferred;

        const inferred = [];
        for (const guideline of guidelines ?? []) {
            const response = WeatherAlerts.#ResponseFromGuideline(guideline);
            if (response && !inferred.includes(response)) inferred.push(response);
        }
        return inferred.length ? inferred : guidelines?.length ? ["monitor"] : [];
    }

    static #BuildFlatBufferResponses(guidelines, preferredResponses = []) {
        const responses = [];
        for (const response of WeatherAlerts.#BuildResponses(guidelines, preferredResponses)) {
            const value = WeatherAlerts.#FlatBufferEnum("responses", response);
            if (value && !responses.includes(value)) responses.push(value);
        }
        return responses;
    }

    static #ResponseFromGuideline(guideline) {
        const text = String(guideline ?? "")
            .trim()
            .toLowerCase();
        if (!text) return null;
        const compact = text.replace(/\s+/g, "");

        if (/撤离|疏散|转移|离开/.test(text) || compact.includes("evacuat")) return "evacuate";
        if (/就地|躲避|避难|避险|避风|室内|躲到|进入室内|待在室内/.test(text) || compact.includes("takeshelter") || compact.includes("seekshelter")) return "shelter";
        if (/执行|实施|预案|计划/.test(text) || compact.includes("execute") || compact.includes("carryout") || compact.includes("implement")) return "execute";
        if (/准备|防范|防护|备好|做好.*准备/.test(text) || compact.includes("prepare") || compact.includes("preparations")) return "prepare";
        if (/远离|避免|不要|切勿|勿|别/.test(text) || compact.includes("avoid") || compact.includes("stayaway") || compact.includes("keepaway") || compact.includes("donot") || compact.includes("dont")) return "avoid";
        if (/密切关注|持续关注|关注|留意|监测|观察|跟踪/.test(text) || compact.includes("monitor") || compact.includes("watch") || compact.includes("followup")) return "monitor";
        if (/评估|检查/.test(text) || compact.includes("assess") || compact.includes("inspect")) return "assess";
        if (/解除|恢复正常/.test(text) || compact.includes("allclear")) return "allClear";
        if (/无需|不需|无须/.test(text) || compact.includes("none")) return "none";
        return null;
    }

    static #FlatBufferEnum(key, value) {
        const normalized = String(value ?? "")
            .trim()
            .replace(/[_\s-]+/g, "")
            .toLowerCase();
        if (!normalized) return "";

        const values = {
            certainty: {
                observed: "OBSERVED",
                likely: "LIKELY",
                possible: "POSSIBLE",
                unlikely: "UNLIKELY",
                unknown: "UNKNOWN",
            },
            // This checkout pins an older WeatherKit schema whose wire values
            // use HIGHER/LOWER and ALLCLEAR names. They share the same numeric
            // values as the newer upstream HIGH/LOW and ALL_CLEAR aliases.
            importance: { high: "HIGHER", normal: "NORMAL", low: "LOWER" },
            responses: {
                evacuate: "EVACUATE",
                shelter: "SHELTER",
                execute: "EXECUTE",
                prepare: "PREPARE",
                avoid: "AVOID",
                monitor: "MONITOR",
                assess: "ASSESS",
                allclear: "ALLCLEAR",
                none: "NONE",
            },
            severity: {
                unknown: "UNKNOWN",
                extreme: "EXTREME",
                severe: "SEVERE",
                moderate: "MODERATE",
                minor: "MINOR",
            },
            significance: {
                advisory: "ADVISORY",
                warning: "WARNING",
                statement: "STATEMENT",
                unknown: "UNKNOWN",
            },
            urgency: {
                immediate: "IMMEDIATE",
                expected: "EXPECTED",
                future: "FUTURE",
                past: "PAST",
                unknown: "UNKNOWN",
            },
        };
        return values[key]?.[normalized] ?? "";
    }

    static #StableUUID(value) {
        const input = String(value ?? "");
        const words = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
        for (let index = 0; index < words.length; index++) {
            for (let offset = 0; offset < input.length; offset++) {
                words[index] ^= input.charCodeAt(offset) + index;
                words[index] = Math.imul(words[index], 0x01000193);
            }
        }

        const bytes = new Uint8Array(16);
        const view = new DataView(bytes.buffer);
        for (let index = 0; index < words.length; index++) view.setUint32(index * 4, words[index]);
        bytes[6] = (bytes[6] & 0x0f) | 0x50;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
}
