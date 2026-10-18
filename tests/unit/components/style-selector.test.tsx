// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StyleSelector } from "@/components/sidebar/StyleSelector";

/**
 * The style selector (T037). Offering exactly the predefined catalogue is its
 * own concern — there is no "new style" option (FR-008). Choosing a style is
 * how the script's register is set for the next AI response, so the control
 * must accept a choice and report it, not sit disabled.
 */

const STYLES = [
  {
    id: "historical-documentary",
    name: "Historical Documentary",
    description: "Measured.",
  },
  { id: "observational", name: "Observational", description: "Watchful." },
];

function stubCatalog() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: STYLES })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StyleSelector", () => {
  it("offers exactly the predefined styles, with no way to add one", async () => {
    stubCatalog();
    render(<StyleSelector styleId={null} onChoose={() => {}} />);

    const select = await screen.findByRole("combobox", { name: /style/i });
    await waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(2));

    expect(
      [...select.querySelectorAll("option")].map((option) => option.textContent),
    ).toEqual(["Historical Documentary", "Observational"]);
    expect(screen.queryByRole("button", { name: /new style/i })).toBeNull();
  });

  it("shows the active script's style as the selected option", async () => {
    stubCatalog();
    render(<StyleSelector styleId="observational" onChoose={() => {}} />);

    const select = (await screen.findByRole("combobox", {
      name: /style/i,
    })) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("observational"));
  });

  it("reports the style the user chose", async () => {
    stubCatalog();
    const onChoose = vi.fn();
    render(<StyleSelector styleId="historical-documentary" onChoose={onChoose} />);

    const select = await screen.findByRole("combobox", { name: /style/i });
    await waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(2));
    fireEvent.change(select, { target: { value: "observational" } });

    expect(onChoose).toHaveBeenCalledWith("observational");
  });

  it("is not selectable when no script is open, since a style belongs to a script", async () => {
    stubCatalog();
    render(<StyleSelector styleId={null} onChoose={null} />);

    const select = await screen.findByRole("combobox", { name: /style/i });

    expect((select as HTMLSelectElement).disabled).toBe(true);
  });
});
