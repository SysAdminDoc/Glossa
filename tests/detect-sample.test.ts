import assert from "node:assert/strict";
import { test } from "node:test";

const { buildSample, isProseLine, MIN_SAMPLE_WEIGHT, weighText } = await import("../src/content/detect-sample.ts");

const SPANISH = [
  "La biblioteca abre todos los días de la semana, excepto los domingos.",
  "Puedes consultar el catálogo en línea antes de tu visita.",
  "Cada persona puede tomar prestados hasta cinco libros de la sala principal.",
  "El préstamo dura tres semanas y se puede renovar una vez sin coste."
];

test("a page of numbers gives the detector nothing to work with", () => {
  const json = ['{"id": 12345, "total": 99.5, "count": 3}', '{"id": 12346, "total": 12.0, "count": 8}'];
  assert.equal(buildSample(json), "");
  const table = ["2026-09-10 12:45:01", "1.234,56", "99 %", "17/09"];
  assert.equal(buildSample(table), "");
});

test("a wall of urls is not evidence of a language", () => {
  const links = Array.from({ length: 40 }, (_, i) => `https://ejemplo.es/catalogo/${i}?ref=nav`);
  assert.equal(buildSample(links), "");
  assert.equal(isProseLine("https://ejemplo.es/catalogo/1?ref=nav"), false);
  assert.equal(isProseLine("info@ejemplo.es"), false);
  // A sentence that happens to contain an address is still a sentence.
  assert.equal(isProseLine("Escribe a info@ejemplo.es para reservar una sala de lectura hoy."), true);
});

test("real prose comes through, whitespace collapsed", () => {
  const sample = buildSample(["\n  La biblioteca   abre todos los días de la semana  \t", ...SPANISH.slice(1)]);
  assert.match(sample, /^La biblioteca abre todos los días de la semana Puedes consultar/);
  assert.ok(weighText(sample) >= MIN_SAMPLE_WEIGHT);
});

test("a page with only a few words is left undecided", () => {
  assert.equal(buildSample(["Hola mundo", "Bienvenido"]), "");
  // The same words repeated until there is enough to judge do pass.
  assert.notEqual(buildSample(Array.from({ length: 30 }, () => "Hola mundo, bienvenido a la biblioteca")), "");
});

test("navigation labels alone do not reach the threshold", () => {
  assert.equal(buildSample(["Inicio", "Catálogo", "Horarios", "Contacto"]), "");
});

test("the sample stays inside its budget", () => {
  const long = Array.from({ length: 200 }, () => "La biblioteca abre todos los días de la semana excepto los domingos.");
  assert.ok(buildSample(long, 500).length <= 500);
});

// Scripts that say in forty characters what English needs a hundred and fifty for. Counting raw
// letters made every one of these look like an empty page, and an empty sample falls back to
// whatever <html lang> claims, which on a Chinese page built from an English template is "en".
const PAGES: Record<string, string[]> = {
  japanese: [
    "図書館は日曜日を除いて毎日開いています。",
    "訪問前にオンラインカタログを確認できます。",
    "一人につき五冊まで借りることができます。"
  ],
  chinese: ["图书馆每天开放，星期日除外。", "您可以在访问前查看在线目录。", "每人最多可借五本书。"],
  korean: [
    "도서관은 일요일을 제외하고 매일 문을 엽니다.",
    "방문 전에 온라인 목록을 확인할 수 있습니다.",
    "한 사람당 다섯 권까지 빌릴 수 있습니다."
  ],
  hindi: [
    "पुस्तकालय रविवार को छोड़कर हर दिन खुला रहता है।",
    "आप अपनी यात्रा से पहले ऑनलाइन सूची देख सकते हैं।",
    "प्रत्येक व्यक्ति पाँच पुस्तकें उधार ले सकता है।"
  ],
  thai: [
    "ห้องสมุดเปิดทุกวันยกเว้นวันอาทิตย์",
    "คุณสามารถดูรายการออนไลน์ก่อนมาเยี่ยมชม",
    "แต่ละคนสามารถยืมหนังสือได้ห้าเล่ม"
  ],
  arabic: [
    "المكتبة مفتوحة كل يوم ما عدا يوم الأحد.",
    "يمكنك الاطلاع على الفهرس عبر الإنترنت قبل زيارتك.",
    "يمكن لكل شخص استعارة خمسة كتب."
  ]
};

for (const [language, lines] of Object.entries(PAGES)) {
  test(`three paragraphs of ${language} are enough to judge`, () => {
    const sample = buildSample(lines);
    assert.notEqual(sample, "", `${language} prose was reported as undetectable`);
    assert.ok(sample.includes(lines[0]!.slice(0, 6)), "the sample dropped the first paragraph");
  });
}

test("text that arrives one character per node is still text", () => {
  // Japanese pages with furigana, and Chinese pages built by some frameworks, put every character
  // in its own text node. A per-line floor measured in letters throws all of it away.
  const characters = "図書館は日曜日を除いて毎日開いています訪問前にオンラインカタログを確認できます一人につき五冊まで借りることができます".split("");
  assert.notEqual(buildSample(characters), "", "single-character nodes were all rejected");
  // A Spanish sentence broken up by inline links keeps its short pieces too.
  const pieces = "La biblioteca abre todos los días de la semana excepto los domingos y el catálogo está en línea".split(" ");
  assert.notEqual(buildSample(pieces), "");
});

test("a handful of characters is still not enough, whatever the script", () => {
  assert.equal(buildSample("図書館は毎日".split("")), "");
  assert.equal(buildSample(["Hola"]), "");
});
