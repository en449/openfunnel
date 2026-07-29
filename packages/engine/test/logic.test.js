/**
 * DOM-free unit tests for the engine's core logic. Run with `bun test`.
 * These cover the parts that decide funnel behaviour independent of rendering:
 * branch resolution, field validation, and answer piping.
 */
import { test, expect } from "bun:test";
import { resolveNext } from "../src/branching.js";
import { validateField, validateForm } from "../src/validate.js";
import { pipe } from "../src/piping.js";

/** @type {any[]} */
const steps = [
  { id: "a", type: "choice", options: [] },
  { id: "b", type: "choice", options: [] },
  { id: "c", type: "form", fields: [] },
];

test("resolveNext falls through linearly by default", () => {
  expect(resolveNext(steps, 0, undefined)).toBe(1);
  expect(resolveNext(steps, 1, undefined)).toBe(2);
});

test("resolveNext ends the funnel at the last step", () => {
  expect(resolveNext(steps, 2, undefined)).toBe(-1);
});

test("resolveNext honours an option branch target by id", () => {
  expect(resolveNext(steps, 0, "c")).toBe(2);
});

test("resolveNext treats null as an explicit end", () => {
  expect(resolveNext(steps, 0, null)).toBe(-1);
});

test("resolveNext falls through when a branch id is unknown", () => {
  expect(resolveNext(steps, 0, "nope")).toBe(1);
});

test("email validation catches obvious typos", () => {
  const f = { name: "email", type: "email", required: true };
  expect(validateField(f, "jane@company.com")).toBe("");
  expect(validateField(f, "not-an-email")).not.toBe("");
  expect(validateField(f, "")).not.toBe(""); // required
});

test("optional empty fields are valid", () => {
  const f = { name: "phone", type: "tel", required: false };
  expect(validateField(f, "")).toBe("");
});

test("phone needs at least 7 digits", () => {
  const f = { name: "phone", type: "tel", required: true };
  expect(validateField(f, "+1 (555) 123-4567")).toBe("");
  expect(validateField(f, "123")).not.toBe("");
});

test("validateForm returns only the invalid fields", () => {
  const fields = [
    { name: "name", type: "name", required: true },
    { name: "email", type: "email", required: true },
  ];
  const errors = validateForm(fields, { name: "Jane", email: "bad" });
  expect(Object.keys(errors)).toEqual(["email"]);
});

test("pipe substitutes lead then answers, and blanks unknown tokens", () => {
  expect(pipe("Hi {{name}}!", { lead: { name: "Jo" } })).toBe("Hi Jo!");
  expect(pipe("Goal: {{goal}}", { answers: { goal: "grow" } })).toBe("Goal: grow");
  expect(pipe("Hi {{missing}}!", {})).toBe("Hi !");
  expect(pipe("Picked {{c}}", { answers: { c: ["a", "b"] } })).toBe("Picked a, b");
});
