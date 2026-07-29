const BASE32_PREFIX = "b32_";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function bytesToBase32(bytes) {
    let output = "";
    let value = 0;
    let bits = 0;

    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }

    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return output;
}

function base32ToBytes(input) {
    if (!/^[a-z2-7]+$/.test(input)) {
        throw new TypeError("Invalid base32 configuration payload");
    }

    const bytes = [];
    let value = 0;
    let bits = 0;
    for (const character of input) {
        value = (value << 5) | BASE32_ALPHABET.indexOf(character);
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Uint8Array.from(bytes);
}

function decodeLegacyBase64Url(input) {
    let normalized = input.replace(/-/g, "+").replace(/_/g, "/");
    while (normalized.length % 4) normalized += "=";
    const binary = atob(normalized);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
}

/**
 * Encode configuration JSON with a lowercase-only alphabet.
 * Loon normalizes rewritten host/path values to lowercase, so mixed-case
 * base64url cannot safely be embedded in its rewritten request path.
 */
export function encodeConfigPayload(input) {
    return `${BASE32_PREFIX}${bytesToBase32(new TextEncoder().encode(input))}`;
}

/** Decode current lowercase Base32 payloads and legacy base64/base64url links. */
export function decodeConfigPayload(input) {
    const bytes = input.startsWith(BASE32_PREFIX) ? base32ToBytes(input.slice(BASE32_PREFIX.length)) : decodeLegacyBase64Url(input);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
