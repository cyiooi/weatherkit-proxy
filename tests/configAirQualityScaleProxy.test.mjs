import assert from "node:assert/strict";
import test from "node:test";
import { decodeConfigPayload, encodeConfigPayload } from "../src/function/configPayload.mjs";
import database from "../src/function/database.mjs";
import { renderIndex } from "../src/function/indexPage.mjs";
import app from "../src/Hono.js";

const CONFIG_FILES = ["weatherkit-proxy.sgmodule", "weatherkit-proxy.srmodule", "weatherkit-proxy.plugin", "weatherkit-proxy.stoverride", "weatherkit-proxy.yaml", "weatherkit-proxy.snippet"];

function encodeConfig(config) {
    return Buffer.from(JSON.stringify(config)).toString("base64url");
}

function encodeCurrentConfig(config) {
    return encodeConfigPayload(JSON.stringify(config));
}

async function downloadConfig(path) {
    const response = await app.request(`https://proxy.example${path}`, { headers: { host: "proxy.example" } });
    assert.equal(response.status, 200);
    return response.text();
}

test("配置页默认代理 airQualityScale，并启用逐日、逐小时替换", () => {
    const html = renderIndex("proxy.example", "https");
    const proxyInput = html.match(/<input[^>]*id="proxyAirQualityScale"[^>]*>/)?.[0];
    assert.ok(proxyInput, "配置页应包含 airQualityScale 代理开关");
    assert.match(proxyInput, /\bchecked\b/, "airQualityScale 代理默认应勾选");
    for (const id of ["replaceDaily", "replaceHourly"]) {
        const input = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
        assert.ok(input, `配置页应包含 ${id} 开关`);
        assert.match(input, /\bchecked\b/, `${id} 默认应勾选`);
    }
    assert.match(html, /id="resetConfigBtn"/, "配置页应提供恢复默认配置按钮");
    assert.match(html, /id="domainPolicy"[^>]*value="DIRECT"/, "部署域名分流默认应为 DIRECT");
    const qweatherAlertsInput = html.match(/<input[^>]*id="qweatherWeatherAlerts"[^>]*>/)?.[0];
    assert.ok(qweatherAlertsInput, "纯和风配置应提供天气预警补全开关");
    assert.doesNotMatch(qweatherAlertsInput, /\bchecked\b/, "和风天气预警补全默认应关闭");
    assert.match(html, /id="weatherAlertsProvider"/, "配置页应提供天气预警补全数据源");
    const weatherAlertsSelect = html.match(/<select[^>]*id="weatherAlertsProvider"[^>]*>.*?<\/select>/)?.[0];
    assert.ok(weatherAlertsSelect, "配置页应包含天气预警数据源选项");
    assert.match(weatherAlertsSelect, /<option value="WeatherKit" selected>/, "天气预警补全默认应关闭");
    assert.match(html, /WeatherAlerts: \{ Provider: presetData\.Advanced\.weatherAlertsProvider \}/, "高级配置应保存天气预警数据源");
    assert.match(html, /WeatherAlerts: \{ Provider: presetData\.Caiyun\.caiyunToken \? "ColorfulClouds" : "WeatherKit" \}/, "纯彩云配置无 CAP Token 时不应启用第三方预警补全");
    assert.match(html, /WeatherAlerts: \{ Provider: presetData\.QWeather\.weatherAlertsEnabled \? "QWeather" : "WeatherKit" \}/, "纯和风配置应由显式开关控制预警补全");
    assert.equal(database.WeatherKit.Settings.Weather.ReplaceDaily, true);
    assert.equal(database.WeatherKit.Settings.Weather.ReplaceHourly, true);
    assert.equal(database.WeatherKit.Settings.WeatherAlerts.Provider, "WeatherKit");
});

test("新配置载荷只使用小写 Base32，并保留大小写敏感配置值", () => {
    const json = JSON.stringify({
        Proxy: { DomainPolicy: "🚀 节点选择" },
        Weather: { Provider: "QWeather" },
        API: { QWeather: { Token: "AbCdEf-123_测试" } },
    });
    const encoded = encodeConfigPayload(json);
    assert.match(encoded, /^b32_[a-z2-7]+$/);
    assert.equal(encoded, encoded.toLowerCase());
    assert.equal(decodeConfigPayload(encoded), json);
});

test("客户端配置默认代理 airQualityScale 与坐标型 weatherAlerts", async () => {
    for (const filename of CONFIG_FILES) {
        const content = await downloadConfig(`/conf/${filename}`);
        assert.match(content, /\/api\/v1\/airQualityScale\//, filename);
        assert.match(content, /\/api\/v1\/weatherAlerts\\?/, filename);
        assert.match(content, /ids=-\?\[0-9\]/, `${filename} 应限制为坐标型预警标识`);
        assert.doesNotMatch(content, /ids=\.\{6,\}/, `${filename} 不应接管 Apple 原生预警 UUID`);
        assert.doesNotMatch(content, /__AIR_QUALITY_SCALE_PROXY_/, `${filename} 不应泄露模板标记`);
        assert.match(content, /\/api\/v2\/weather\//, `${filename} 应保留天气代理规则`);
    }
});

test("页面关闭选项后，同一文件名的客户端配置不代理 airQualityScale", async () => {
    const encoded = encodeConfig({ Proxy: { AirQualityScale: false } });
    for (const filename of CONFIG_FILES) {
        const content = await downloadConfig(`/conf/${encoded}/${filename}`);
        assert.doesNotMatch(content, /\/api\/v1\/airQualityScale\//, filename);
        assert.doesNotMatch(content, /__AIR_QUALITY_SCALE_PROXY_/, `${filename} 不应泄露模板标记`);
    }
});

test("客户端配置可为部署域名渲染自定义分流策略", async () => {
    const encoded = encodeCurrentConfig({
        Proxy: {
            AirQualityScale: true,
            DomainPolicy: "🚀 节点选择",
        },
    });
    const expectations = {
        "weatherkit-proxy.sgmodule": /DOMAIN-SUFFIX,proxy\.example,🚀 节点选择/,
        "weatherkit-proxy.srmodule": /DOMAIN-SUFFIX,proxy\.example,🚀 节点选择/,
        "weatherkit-proxy.plugin": /DOMAIN-SUFFIX,proxy\.example,🚀 节点选择/,
        "weatherkit-proxy.stoverride": /DOMAIN-SUFFIX,proxy\.example,🚀 节点选择/,
        "weatherkit-proxy.yaml": /match: proxy\.example\s+policy: "🚀 节点选择"/,
        "weatherkit-proxy.snippet": /host-suffix, proxy\.example, 🚀 节点选择/,
    };

    for (const [filename, expectation] of Object.entries(expectations)) {
        const content = await downloadConfig(`/conf/${encoded}/${filename}`);
        assert.match(content, expectation, filename);
        assert.doesNotMatch(content, /__DOMAIN_POLICY__/, `${filename} 不应泄露策略占位符`);
    }
});

test("无效分流策略安全回退为 DIRECT", async () => {
    const encoded = encodeCurrentConfig({ Proxy: { DomainPolicy: "PROXY,\nFINAL" } });
    const surge = await downloadConfig(`/conf/${encoded}/weatherkit-proxy.sgmodule`);
    const quantumultx = await downloadConfig(`/conf/${encoded}/weatherkit-proxy.snippet`);
    assert.match(surge, /DOMAIN-SUFFIX,proxy\.example,DIRECT/);
    assert.match(quantumultx, /host-suffix, proxy\.example, direct/);
});

test("Loon 模板使用当前插件规则语法", async () => {
    const content = await downloadConfig("/conf/weatherkit-proxy.plugin");
    assert.match(content, /\[Rewrite\]/);
    assert.match(content, /DEST-PORT,443/);
    assert.doesNotMatch(content, /\[URL Rewrite\]/);
    assert.doesNotMatch(content, /DST-PORT/);
    assert.doesNotMatch(content, /REJECT-NO-DROP/);
});
