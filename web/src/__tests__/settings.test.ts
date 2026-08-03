import { describe, expect, it } from "vitest";
import { loadSettings, withSourceLayout } from "../settings";

const layout = [{ i: "vwc", x: 0, y: 0, w: 12, h: 4 }];

function key(email: string): string {
  return `soil-sensor-settings-${email.toLowerCase()}`;
}

describe("source-specific dashboard layouts", () => {
  it("keeps layouts independent between sources", () => {
    const first = withSourceLayout({}, "source-a", layout);
    const second = withSourceLayout(first, "source-b", [
      { i: "vwc", x: 0, y: 0, w: 6, h: 3 },
    ]);

    expect(second["source-a"]).toEqual(layout);
    expect(second["source-b"]).toEqual([{ i: "vwc", x: 0, y: 0, w: 6, h: 3 }]);
  });

  it("migrates the legacy layout only to the previously selected source", () => {
    localStorage.setItem(key("User@example.com"), JSON.stringify({
      selectedSourceId: "source-a",
      layout,
    }));

    const settings = loadSettings("USER@example.com");
    expect(settings.layoutsBySource["source-a"]).toEqual(layout);
    expect((settings as unknown as { layout?: unknown }).layout).toBeUndefined();
    expect(settings.layoutsBySource["source-b"]).toBeUndefined();
  });
});
