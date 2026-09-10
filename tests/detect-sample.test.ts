import assert from "node:assert/strict";
import { test } from "node:test";

const { buildSample, isProseLine, MIN_SAMPLE_LETTERS } = await import("../src/content/detect-sample.ts");

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
  assert.ok(sample.length > MIN_SAMPLE_LETTERS);
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
