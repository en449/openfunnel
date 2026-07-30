import { describe, expect, test } from "bun:test";
import { evaluateFormula } from "../src/calculator.js";

describe("evaluateFormula", () => {
  test("evaluates simple addition and multiplication", () => {
    expect(evaluateFormula("10 + 20")).toBe(30);
    expect(evaluateFormula("10 * 50")).toBe(500);
  });

  test("evaluates complex expressions with parentheses", () => {
    expect(evaluateFormula("(10 + 20) * 5")).toBe(150);
    expect(evaluateFormula("2400 + 100 / 2")).toBe(2450);
  });

  test("handles empty or invalid inputs gracefully", () => {
    expect(evaluateFormula("")).toBe(0);
    expect(evaluateFormula(null)).toBe(0);
    expect(evaluateFormula("invalid text")).toBe(0);
  });
});
