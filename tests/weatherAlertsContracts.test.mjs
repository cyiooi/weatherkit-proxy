import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Builder, ByteBuffer } from "flatbuffers";
import ColorfulClouds from "../src/class/ColorfulClouds.mjs";
import QWeather, { QWEATHER_ALERT_TIMEOUT_SECONDS, QWEATHER_PUBLIC_TOKEN } from "../src/class/QWeather.mjs";
import WeatherAlerts from "../src/class/WeatherAlerts.mjs";
import WeatherKit2 from "../src/class/WeatherKit2.mjs";
import { encodeConfigPayload } from "../src/function/configPayload.mjs";
import app from "../src/Hono.js";
import { Response } from "../src/process/Response.mjs";

const QWEATHER_ALERT_API = {
    metadata: {
        attributions: ["国家预警信息发布中心", "当前预警数据可能存在延迟或信息过时，以官方数据发布为准。"],
    },
    alerts: [
        {
            id: "202608021748225061499885",
            areaId: "320100",
            areaName: "南京市",
            senderName: "南京市气象台",
            issuedTime: "2026-08-02T09:48Z",
            effectiveTime: "2026-08-02T09:48Z",
            onsetTime: "2026-08-02T09:48Z",
            expiresTime: "2026-08-03T09:48Z",
            eventType: { name: "高温", code: "1009" },
            severity: "severe",
            headline: "南京市气象台发布高温橙色预警",
            description: "南京市气象台继续发布高温橙色预警信号，请注意防暑降温。",
            responseTypes: ["monitor"],
            instruction: "1. 有关部门落实防暑降温保障措施。\n2. 尽量避免在高温时段进行户外活动。",
        },
    ],
};

const COLORFUL_CLOUDS_ALERT_API = {
    alerts: [
        {
            id: "urn:oid:2.49.0.1.840.0.test",
            source: 1,
            event_name: "Flash Flood Warning",
            urgency: 1,
            severity: 2,
            certainty: 2,
            sent_time: 1_735_689_600,
            effective_time: 1_735_689_660,
            onset_time: 1_735_689_720,
            expires_time: 1_735_776_000,
            areas: [
                {
                    area_desc: "Los Angeles",
                    geocodes: [{ value: "CAC037" }],
                },
            ],
            sender_name: "NWS Los Angeles/Oxnard CA",
            description: "Flash flooding caused by excessive rainfall is expected.",
            instruction: "1. Move to higher ground immediately.\n2. Avoid flooded roads.",
        },
    ],
};

test("Vercel 将 weatherAlerts 详情请求路由到函数", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    const routeIndex = config.routes.findIndex(route => route.src === "/api/v1/weatherAlerts");
    const fallbackIndex = config.routes.findIndex(route => route.src === "/(.*)" && route.status === 404);

    assert.notEqual(routeIndex, -1);
    assert.equal(config.routes[routeIndex].dest, "src/Vercel.js");
    assert.ok(routeIndex < fallbackIndex, "weatherAlerts 路由应位于兜底 404 之前");
});

test("weatherAlerts 只接管合法的明文经纬度标识", () => {
    assert.deepEqual(WeatherAlerts.ParseCoordinateIdentifier("32.115,118.814"), { latitude: "32.115", longitude: "118.814" });
    assert.deepEqual(WeatherAlerts.ParseCoordinateIdentifier("-90,-180"), { latitude: "-90", longitude: "-180" });
    for (const identifier of ["32.115%2C118.814", ".115,118.814", "91,118", "32,181", "35889ee6-fa82-5f9f-8e49-fad78c4f383a", "https://evil.example"]) {
        assert.equal(WeatherAlerts.ParseCoordinateIdentifier(identifier), null, identifier);
    }
});

test("天气预警默认启用 QWeather，非法配置仍安全回退 WeatherKit", () => {
    assert.equal(WeatherAlerts.ResolveProvider({}), "QWeather");
    assert.equal(WeatherAlerts.ResolveProvider({ WeatherAlerts: { Provider: "unknown" } }), "WeatherKit");
    assert.equal(WeatherAlerts.CanUseProvider({}), true);
    assert.equal(WeatherAlerts.CanUseProvider({ WeatherAlerts: { Provider: "ColorfulClouds" }, API: { ColorfulClouds: { Token: null } } }), false);
    assert.equal(WeatherAlerts.CanUseProvider({ WeatherAlerts: { Provider: "ColorfulClouds" }, API: { ColorfulClouds: { Token: "  " } } }), false);
    assert.equal(WeatherAlerts.CanUseProvider({ WeatherAlerts: { Provider: "QWeather" }, API: { QWeather: { Token: null } } }), true);
});

test("和风 Token 为空时使用上游公共 Key", async () => {
    assert.equal(QWEATHER_PUBLIC_TOKEN, "bdd98ec1d87747f3a2e8b1741a5af796");
    assert.equal(QWEATHER_ALERT_TIMEOUT_SECONDS, 10);
    const infoLogs = [];
    const originalConsoleInfo = console.info;
    console.info = (...messages) => infoLogs.push(messages.join(" "));
    try {
        await withMockedFetch(QWEATHER_ALERT_API, async requested => {
            await new QWeather({ country: "CN", language: "zh-CN", latitude: "32.115", longitude: "118.814" }, null).WeatherAlert();
            assert.equal(requested.length, 1);
            assert.equal(requested[0].url, "https://api.qweather.com/weatheralert/v1/current/32.115/118.814?lang=zh-hans");
            assert.equal(requested[0].headers.get("X-QW-Api-Key"), QWEATHER_PUBLIC_TOKEN);
        });
    } finally {
        console.info = originalConsoleInfo;
    }
    assert.ok(
        infoLogs.some(log => /^WeatherAlert QWeather requestDuration: \d+ms timeout: 10s$/.test(log)),
        "应记录和风预警请求耗时与超时上限",
    );
});

test("和风预警 API 使用所选语言、Host 与 Token，并标准化预警字段", async () => {
    await withMockedFetch(QWEATHER_ALERT_API, async requested => {
        let extracted;
        for (const [language, expectedLanguage] of [
            ["zh-CN", "zh-hans"],
            ["zh-TW", "zh-hant"],
            ["en-US", "en"],
            ["de", "de"],
        ]) {
            extracted = await new QWeather({ country: "CN", language, latitude: "32.115", longitude: "118.814" }, "test-token", "api.example.qweather.com").WeatherAlert();
            const request = requested.at(-1);
            assert.equal(request.url, `https://api.example.qweather.com/weatheralert/v1/current/32.115/118.814?lang=${expectedLanguage}`);
            assert.equal(request.headers.get("X-QW-Api-Key"), "test-token");
            assert.equal(request.headers.get("Accept"), "application/json");
            assert.ok(request.signal instanceof AbortSignal, "预警请求应设置超时信号");
        }

        assert.equal(extracted.source, "南京市气象台");
        assert.equal(extracted.areaName, "南京市");
        assert.deepEqual(extracted.alerts[0], {
            areaId: "320100",
            areaName: "南京市",
            certainty: "unknown",
            description: "高温橙色预警",
            effectiveTime: "2026-08-02T09:48:00.000Z",
            eventEndTime: "2026-08-03T09:48:00.000Z",
            eventOnsetTime: "2026-08-02T09:48:00.000Z",
            expireTime: "2026-08-03T09:48:00.000Z",
            guidelines: ["有关部门落实防暑降温保障措施。", "尽量避免在高温时段进行户外活动。"],
            identifier: "202608021748225061499885",
            issuedTime: "2026-08-02T09:48:00.000Z",
            message: "南京市气象台继续发布高温橙色预警信号，请注意防暑降温。",
            phenomenon: "高温",
            reportedAt: "2026-08-02T09:48:00.000Z",
            responses: ["monitor"],
            severity: "severe",
            source: "南京市气象台",
            standard: "",
            token: "1009",
            urgency: "unknown",
        });
    });
});

test("彩云 CAP 预警 API 映射语言并标准化预警字段", async () => {
    await withMockedFetch(COLORFUL_CLOUDS_ALERT_API, async requested => {
        let extracted;
        for (const [language, expectedLanguage] of [
            ["zh-CN", "zh_CN"],
            ["zh-Hant", "zh_TW"],
            ["en-US", "en_US"],
            ["en-GB", "en_GB"],
            ["ja", "ja"],
            ["de", "zh_CN"],
        ]) {
            extracted = await new ColorfulClouds({ country: "US", language, latitude: "34.05", longitude: "-118.25" }, "test-token").WeatherAlert();
            const request = new URL(requested.at(-1).url);
            assert.equal(request.origin + request.pathname, "https://singer.caiyunhub.com/v3/cap_alert/location");
            assert.equal(request.searchParams.get("token"), "test-token");
            assert.equal(request.searchParams.get("longitude"), "-118.25");
            assert.equal(request.searchParams.get("latitude"), "34.05");
            assert.equal(request.searchParams.get("language"), expectedLanguage);
            assert.equal(requested.at(-1).headers.get("Referer"), "https://caiyunapp.com/");
            assert.ok(requested.at(-1).signal instanceof AbortSignal, "预警请求应设置超时信号");
        }

        assert.equal(extracted.source, "NWS Los Angeles/Oxnard CA");
        assert.equal(extracted.areaName, "Los Angeles");
        assert.deepEqual(extracted.alerts[0], {
            areaId: "CAC037",
            areaName: "Los Angeles",
            certainty: "likely",
            description: "Flash Flood Warning",
            effectiveTime: "2025-01-01T00:01:00.000Z",
            eventEndTime: "2025-01-02T00:00:00.000Z",
            eventOnsetTime: "2025-01-01T00:02:00.000Z",
            expireTime: "2025-01-02T00:00:00.000Z",
            guidelines: ["Move to higher ground immediately.", "Avoid flooded roads."],
            identifier: "urn:oid:2.49.0.1.840.0.test",
            issuedTime: "2025-01-01T00:00:00.000Z",
            message: "Flash flooding caused by excessive rainfall is expected.",
            phenomenon: "Flash Flood Warning",
            reportedAt: "2025-01-01T00:00:00.000Z",
            severity: "severe",
            source: "NWS Los Angeles/Oxnard CA",
            standard: "",
            urgency: "immediate",
        });
    });
});

test("v1 weatherAlerts 详情接口按配置返回 Apple 兼容 JSON", async () => {
    const encoded = encodeConfigPayload(
        JSON.stringify({
            WeatherAlerts: { Provider: "QWeather" },
            API: { QWeather: { Token: "test-token", Host: "api.example.qweather.com" } },
        }),
    );

    await withMockedFetch(QWEATHER_ALERT_API, async requested => {
        const response = await app.request(`https://proxy.example/p/${encoded}/api/v1/weatherAlerts?lang=zh-CN&ids=32.115,118.814&country=CN`);
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
        assert.equal(response.headers.get("Cache-Control"), "max-age=0");
        assert.equal(requested.length, 1);
        assert.equal(body.length, 1);
        assert.match(body[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.equal(body[0].areaId, "320100");
        assert.equal(body[0].countryCode, "CN");
        assert.equal(body[0].description, "高温橙色预警");
        assert.equal(body[0].attributionURL, "https://www.12379.cn/");
        assert.equal(body[0].importance, "high");
        assert.deepEqual(body[0].responses, ["monitor"]);
        assert.deepEqual(body[0].messages, [
            { language: "zh-CN", text: "南京市气象台继续发布高温橙色预警信号，请注意防暑降温。" },
            { language: "zh-CN", text: "有关部门落实防暑降温保障措施。\n尽量避免在高温时段进行户外活动。" },
        ]);
    });
});

test("v1 weatherAlerts 默认使用 api.qweather.com 与公共 Key", async () => {
    await withMockedFetch(QWEATHER_ALERT_API, async requested => {
        const response = await app.request("https://proxy.example/api/v1/weatherAlerts?lang=zh-CN&ids=32.115,118.814&country=CN");
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(requested.length, 1);
        assert.equal(requested[0].url, "https://api.qweather.com/weatheralert/v1/current/32.115/118.814?lang=zh-hans");
        assert.equal(requested[0].headers.get("X-QW-Api-Key"), QWEATHER_PUBLIC_TOKEN);
        assert.equal(body.length, 1);
        assert.equal(body[0].areaId, "320100");
    });
});

test("v1 weatherAlerts 显式选择 WeatherKit 时不请求 QWeather 并透传 Apple 原始详情", async () => {
    const encoded = encodeConfigPayload(JSON.stringify({ WeatherAlerts: { Provider: "WeatherKit" } }));
    const requested = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async input => {
        const url = typeof input === "string" ? input : input?.url;
        requested.push(url);
        return new globalThis.Response(JSON.stringify([{ id: "apple-alert", source: "Apple" }]), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };

    try {
        const response = await app.request(`https://proxy.example/p/${encoded}/api/v1/weatherAlerts?lang=zh-CN&ids=32.115,118.814&country=CN`);
        assert.deepEqual(await response.json(), [{ id: "apple-alert", source: "Apple" }]);
        assert.equal(requested.length, 1);
        assert.match(requested[0], /^https:\/\/weatherkit\.apple\.com\/api\/v1\/weatherAlerts\?/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("v1 weatherAlerts 的旧彩云配置缺少 Token 时直接透传 Apple", async () => {
    const encoded = encodeConfigPayload(
        JSON.stringify({
            WeatherAlerts: { Provider: "ColorfulClouds" },
            API: { ColorfulClouds: { Token: null } },
        }),
    );
    const requested = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async input => {
        const url = typeof input === "string" ? input : input?.url;
        requested.push(url);
        return new globalThis.Response(JSON.stringify([{ id: "apple-alert", source: "Apple" }]), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };

    try {
        const response = await app.request(`https://proxy.example/p/${encoded}/api/v1/weatherAlerts?lang=zh-CN&ids=32.115,118.814&country=CN`);
        assert.deepEqual(await response.json(), [{ id: "apple-alert", source: "Apple" }]);
        assert.equal(requested.length, 1);
        assert.match(requested[0], /^https:\/\/weatherkit\.apple\.com\/api\/v1\/weatherAlerts\?/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("v1 weatherAlerts 第三方连接失败时回退 Apple 原始详情", async () => {
    const encoded = encodeConfigPayload(
        JSON.stringify({
            WeatherAlerts: { Provider: "ColorfulClouds" },
            API: { ColorfulClouds: { Token: "cap-token" } },
        }),
    );
    const requested = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async input => {
        const url = typeof input === "string" ? input : input?.url;
        requested.push(url);
        if (url.startsWith("https://singer.caiyunhub.com/")) throw new TypeError("fetch failed");
        return new globalThis.Response(JSON.stringify([{ id: "apple-alert", source: "Apple" }]), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };

    try {
        const response = await app.request(`https://proxy.example/p/${encoded}/api/v1/weatherAlerts?lang=zh-CN&ids=32.115,118.814&country=CN`);
        assert.deepEqual(await response.json(), [{ id: "apple-alert", source: "Apple" }]);
        assert.equal(requested.length, 2);
        assert.match(requested[0], /^https:\/\/singer\.caiyunhub\.com\/v3\/cap_alert\/location\?/);
        assert.match(requested[1], /^https:\/\/weatherkit\.apple\.com\/api\/v1\/weatherAlerts\?/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("v1 weatherAlerts 的 Apple 原生 UUID 继续透传上游", async () => {
    const identifier = "35889ee6-fa82-5f9f-8e49-fad78c4f383a";
    const originalFetch = globalThis.fetch;
    let upstreamUrl;
    globalThis.fetch = async input => {
        upstreamUrl = typeof input === "string" ? input : input?.url;
        return new globalThis.Response(JSON.stringify([{ id: identifier, source: "Apple" }]), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };

    try {
        const response = await app.request(`https://proxy.example/api/v1/weatherAlerts?lang=zh-CN&ids=${identifier}`);
        assert.equal(upstreamUrl, `https://weatherkit.apple.com/api/v1/weatherAlerts?lang=zh-CN&ids=${identifier}`);
        assert.deepEqual(await response.json(), [{ id: identifier, source: "Apple" }]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("预警摘要只补缺失字段，并使用本仓库固定 schema 的枚举别名", () => {
    const target = {
        description: "高温",
        phenomenon: "Other",
        responses: [],
        severity: "UNKNOWN",
        certainty: "UNKNOWN",
        importance: "UNKNOWN",
        significance: "UNKNOWN",
        urgency: "UNKNOWN",
        source: "国家预警信息发布中心",
    };
    WeatherAlerts.mergeAlerts(
        [target],
        [
            {
                description: "高温橙色预警",
                phenomenon: "高温",
                guidelines: ["做好应急准备。", "危险解除后恢复正常。"],
                severity: "severe",
                certainty: "likely",
                importance: "high",
                significance: "warning",
                urgency: "expected",
                source: "南京市气象台",
            },
        ],
    );

    assert.equal(target.description, "高温橙色预警");
    assert.equal(target.phenomenon, "高温");
    assert.deepEqual(target.responses, ["PREPARE", "ALLCLEAR"]);
    assert.equal(target.severity, "SEVERE");
    assert.equal(target.certainty, "LIKELY");
    assert.equal(target.importance, "HIGHER");
    assert.equal(target.significance, "WARNING");
    assert.equal(target.urgency, "EXPECTED");
    assert.equal(target.source, "国家预警信息发布中心", "已有 Apple 来源不得被覆盖");

    const unsupported = { significance: "UNKNOWN" };
    WeatherAlerts.mergeAlerts([unsupported], [{ significance: "watch" }]);
    assert.equal(unsupported.significance, "UNKNOWN", "固定 schema 不支持的枚举不得伪装成有效值");

    const established = { description: "Apple 已有的具体雷暴预警" };
    WeatherAlerts.mergeAlerts([established], [{ description: "高温橙色预警", phenomenon: "高温" }]);
    assert.equal(established.description, "Apple 已有的具体雷暴预警", "具体 Apple 摘要不得被覆盖");
});

test("v2 weatherAlerts 显式关闭补全时不请求第三方并保留原始字节", async () => {
    const originalBytes = createWeatherAlertRoot("National Early Warning Center");
    const response = await Response(
        {
            url: "https://weatherkit.apple.com/api/v2/weather/zh-Hans-CN/32.115/118.814?country=CN&dataSets=weatherAlerts",
        },
        {
            bodyBytes: originalBytes,
            headers: { "Content-Type": "application/vnd.apple.flatbuffer" },
            status: 200,
        },
        {
            Settings: { Weather: { Replace: [] }, WeatherAlerts: { Provider: "WeatherKit" } },
            parameters: { country: "CN", dataSets: ["weatherAlerts"], language: "zh-Hans", latitude: 32.115, longitude: 118.814 },
            enviroments: {
                country: "CN",
                qWeather: { WeatherAlert: async () => assert.fail("显式关闭时不应请求和风预警") },
            },
        },
    );

    assert.deepEqual(new Uint8Array(response.body), originalBytes);
});

test("v2 weatherAlerts 在非天气替换国家也会补全，并保留单条 Apple 链接与来源", async () => {
    const originalBytes = createWeatherAlertRoot("National Early Warning Center");
    const response = await Response(
        {
            url: "https://weatherkit.apple.com/api/v2/weather/zh-Hans-US/32.115/118.814?country=US&dataSets=weatherAlerts",
        },
        {
            bodyBytes: originalBytes,
            headers: { "Content-Type": "application/vnd.apple.flatbuffer" },
            status: 200,
        },
        {
            Settings: { Weather: { Replace: [] }, WeatherAlerts: { Provider: "QWeather" }, API: { QWeather: { Token: "test-token" } } },
            parameters: { country: "US", dataSets: ["weatherAlerts"], language: "zh-Hans", latitude: 32.115, longitude: 118.814 },
            enviroments: {
                country: "US",
                qWeather: { WeatherAlert: async () => normalizedQWeatherAlerts() },
            },
        },
    );
    const decoded = WeatherKit2.decode(new ByteBuffer(new Uint8Array(response.body)), ["weatherAlerts"]);
    const alerts = decoded.weatherAlerts;

    assert.notDeepEqual(new Uint8Array(response.body), originalBytes);
    assert.equal(alerts.detailsUrl, "https://weatherkit.apple.com/alertDetails/index.html?ids=32.115,118.814&lang=zh-CN&party=QWeather&country=US");
    assert.equal(alerts.metadata.attributionUrl, "https://developer.qweather.com/attribution.html");
    assert.equal(alerts.alerts.length, 1, "不得新增第三方预警");
    assert.equal(alerts.alerts[0].areaId, "320100");
    assert.equal(alerts.alerts[0].areaName, "南京市");
    assert.equal(alerts.alerts[0].description, "高温橙色预警");
    assert.equal(alerts.alerts[0].eventOnsetTime, 1_785_664_080);
    assert.deepEqual(alerts.alerts[0].responses, ["MONITOR"]);
    assert.equal(alerts.alerts[0].detailsUrl, "https://apple.example/alert/1");
    assert.equal(alerts.alerts[0].source, "National Early Warning Center");
});

test("v2 weatherAlerts 对其他 Apple 数据源保持字节级透传", async () => {
    const originalBytes = createWeatherAlertRoot("The Weather Channel");
    const response = await Response(
        {
            url: "https://weatherkit.apple.com/api/v2/weather/en-US/32.115/118.814?country=US&dataSets=weatherAlerts",
        },
        {
            bodyBytes: originalBytes,
            headers: { "Content-Type": "application/vnd.apple.flatbuffer" },
            status: 200,
        },
        {
            Settings: { Weather: { Replace: [] }, WeatherAlerts: { Provider: "QWeather" }, API: { QWeather: { Token: "test-token" } } },
            parameters: { country: "US", dataSets: ["weatherAlerts"], language: "en", latitude: 32.115, longitude: 118.814 },
            enviroments: {
                country: "US",
                qWeather: { WeatherAlert: async () => assert.fail("不应请求第三方预警") },
            },
        },
    );

    assert.deepEqual(new Uint8Array(response.body), originalBytes);
});

test("v2 weatherAlerts 的旧彩云配置缺少 Token 时不请求第三方并字节级透传", async () => {
    const originalBytes = createWeatherAlertRoot("National Early Warning Center");
    let thirdPartyRequests = 0;
    const response = await Response(
        {
            url: "https://weatherkit.apple.com/api/v2/weather/zh-Hans-US/32.115/118.814?country=US&dataSets=weatherAlerts",
        },
        {
            bodyBytes: originalBytes,
            headers: { "Content-Type": "application/vnd.apple.flatbuffer" },
            status: 200,
        },
        {
            Settings: {
                Weather: { Replace: [] },
                WeatherAlerts: { Provider: "ColorfulClouds" },
                API: { ColorfulClouds: { Token: null } },
            },
            parameters: { country: "US", dataSets: ["weatherAlerts"], language: "zh-Hans", latitude: 32.115, longitude: 118.814 },
            enviroments: {
                country: "US",
                colorfulClouds: {
                    WeatherAlert: async () => {
                        thirdPartyRequests++;
                        return { alerts: [] };
                    },
                },
            },
        },
    );

    assert.equal(thirdPartyRequests, 0);
    assert.deepEqual(new Uint8Array(response.body), originalBytes);
});

async function withMockedFetch(responseBody, callback) {
    const originalFetch = globalThis.fetch;
    const requested = [];
    globalThis.fetch = async (input, init = {}) => {
        const url = typeof input === "string" ? input : (input?.url ?? String(input));
        requested.push({ url, headers: new Headers(init.headers ?? input?.headers ?? {}), signal: init.signal });
        return new globalThis.Response(JSON.stringify(responseBody), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    };
    try {
        await callback(requested);
    } finally {
        globalThis.fetch = originalFetch;
    }
}

function normalizedQWeatherAlerts() {
    return {
        alerts: [
            {
                areaId: "320100",
                areaName: "南京市",
                certainty: "unknown",
                description: "高温橙色预警",
                effectiveTime: "2026-08-02T09:48:00.000Z",
                eventOnsetTime: "2026-08-02T09:48:00.000Z",
                expireTime: "2026-08-03T09:48:00.000Z",
                guidelines: ["密切关注天气变化。"],
                identifier: "202608021748225061499885",
                issuedTime: "2026-08-02T09:48:00.000Z",
                message: "南京市气象台继续发布高温橙色预警信号。",
                phenomenon: "高温",
                reportedAt: "2026-08-02T09:48:00.000Z",
                responses: ["monitor"],
                severity: "severe",
                source: "南京市气象台",
                standard: "",
                token: "1009",
                urgency: "unknown",
            },
        ],
        areaName: "南京市",
        source: "南京市气象台",
    };
}

function createWeatherAlertRoot(providerName) {
    const builder = new Builder(4096);
    const root = WeatherKit2.encode(builder, "all", {
        weatherAlerts: {
            metadata: {
                attributionUrl: "https://apple.example/alerts",
                expireTime: 1_785_623_706,
                language: "zh-CN",
                latitude: 32.115,
                longitude: 118.814,
                providerName,
                readTime: 1_785_623_406,
                reportedTime: 1_785_573_420,
                temporarilyUnavailable: false,
                sourceType: "STATION",
            },
            alerts: [
                {
                    areaId: "",
                    areaName: "",
                    attributionUrl: "https://apple.example/alerts",
                    certainty: "UNKNOWN",
                    countryCode: "US",
                    description: "高温",
                    detailsUrl: "https://apple.example/alert/1",
                    effectiveTime: 1_785_573_420,
                    eventEndTime: 0,
                    eventOnsetTime: 0,
                    eventSource: "US",
                    expireTime: 1_785_659_820,
                    id: "3c9fabb5-4d8e-3d1a-9579-bc3c5b050c1f",
                    importance: "HIGHER",
                    issuedTime: 1_785_573_420,
                    phenomenon: "Other",
                    responses: [],
                    severity: "SEVERE",
                    significance: "UNKNOWN",
                    source: providerName,
                    token: "11B09",
                    urgency: "UNKNOWN",
                },
            ],
            detailsUrl: "https://apple.example/alerts",
        },
    });
    builder.finish(root);
    return builder.asUint8Array().slice();
}
