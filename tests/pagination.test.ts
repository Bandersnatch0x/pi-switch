import { test, describe, expect } from "bun:test";
import { PAGE_SIZE, ensureScroll, pageFlip } from "../src/ui/pagination.ts";

test("PAGE_SIZE is 10", () => {
  expect(PAGE_SIZE).toBe(10);
});

describe("ensureScroll", () => {
  test("returns 0 when everything fits", () => {
    expect(ensureScroll(3, 0, 10, 5)).toBe(0);
  });

  test("scrolls up when the cursor is above the window", () => {
    expect(ensureScroll(2, 5, 10, 30)).toBe(2);
  });

  test("scrolls down when the cursor is below the window", () => {
    expect(ensureScroll(15, 5, 10, 30)).toBe(6);
  });

  test("keeps scroll when the cursor is within the window", () => {
    expect(ensureScroll(7, 5, 10, 30)).toBe(5);
  });
});

describe("pageFlip", () => {
  test("pages forward from a partially scrolled window", () => {
    expect(pageFlip(15, 6, 25, 10, 1)).toEqual({ idx: 20, scroll: 20 });
  });

  test("is a no-op when everything fits one page", () => {
    expect(pageFlip(3, 0, 5, 10, 1)).toEqual({ idx: 3, scroll: 0 });
  });

  test("PgDn advances one page and lands on its top item", () => {
    expect(pageFlip(0, 0, 25, 10, 1)).toEqual({ idx: 10, scroll: 10 });
  });

  test("PgDn from the last page wraps to the first page (cyclic)", () => {
    expect(pageFlip(20, 20, 25, 10, 1)).toEqual({ idx: 0, scroll: 0 });
  });

  test("PgUp from the first page wraps to the last page (cyclic)", () => {
    expect(pageFlip(0, 0, 25, 10, -1)).toEqual({ idx: 20, scroll: 20 });
  });

  test("PgUp retreats one page", () => {
    expect(pageFlip(15, 10, 25, 10, -1)).toEqual({ idx: 0, scroll: 0 });
  });

  test("PgDn onto a partial last page still lands on its top item", () => {
    // 25 items / 10 -> last page [20,25); from page 1 onto page 2.
    expect(pageFlip(12, 10, 25, 10, 1)).toEqual({ idx: 20, scroll: 20 });
  });

  test("total exactly divisible by vis wraps off the last full page", () => {
    expect(pageFlip(10, 10, 20, 10, 1)).toEqual({ idx: 0, scroll: 0 });
  });
});
