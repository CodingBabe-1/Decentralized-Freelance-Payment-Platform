import { describe, expect, it } from "vitest";
import { sanitizeText } from "../lib/sanitize";

describe("sanitizeText", () => {
  it("leaves ordinary text untouched", () => {
    expect(sanitizeText("Fullstack dev & Soroban fan, 5+ yrs")).toBe(
      "Fullstack dev & Soroban fan, 5+ yrs",
    );
    expect(sanitizeText("line one\nline two")).toBe("line one\nline two");
  });

  it("removes script blocks including their content", () => {
    expect(sanitizeText("hi <script>alert(1)</script>there")).toBe("hi there");
    expect(sanitizeText("<SCRIPT src=x></SCRIPT>ok")).toBe("ok");
  });

  it("removes tags with event-handler attributes", () => {
    expect(sanitizeText("<img src=x onerror=alert(1)>hello")).toBe("hello");
    expect(sanitizeText('<a href="x" onclick="y()">link</a>')).toBe("link");
  });

  it("cannot be reassembled from nested fragments", () => {
    const out = sanitizeText("<scr<script>ipt>alert(1)</scr</script>ipt>");
    expect(out).not.toMatch(/[<>]/);
    expect(out.toLowerCase()).not.toContain("<script");
  });

  it("strips HTML character references", () => {
    expect(sanitizeText("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("scriptalert(1)/script");
    expect(sanitizeText("a&#60;b&#x3c;c")).toBe("abc");
  });

  it("removes javascript: and vbscript: schemes, even obfuscated", () => {
    expect(sanitizeText("[x](javascript:alert(1))")).toBe("[x](alert(1))");
    expect(sanitizeText("[x](JaVa\tScRiPt:alert(1))")).not.toMatch(/script\s*:/i);
    expect(sanitizeText("vbscript:msgbox")).toBe("msgbox");
  });

  it("neutralises data: URIs in markdown destinations", () => {
    expect(sanitizeText("![x](data:text/html;base64,AAAA)")).toBe("![x]()");
  });

  it("drops control characters and stray angle brackets", () => {
    expect(sanitizeText("a\u0000b\u0007c")).toBe("abc");
    expect(sanitizeText("1 < 2 > 0")).toBe("1  2  0");
  });
});
