import { test, expect } from "@playwright/test";
import { createTestApi } from "./helpers";

test.describe("Agents Host Codex Elevation", () => {
  test("shows elevation controls and logs dialog in Tasks tab", async ({ page }) => {
    const api = await createTestApi();

    try {
      await api.ensureCodexAgentForE2E();

      const token = api.getToken();
      const workspaceSlug = api.getWorkspaceSlug();
      if (!token || !workspaceSlug) {
        throw new Error("missing test auth token or workspace slug");
      }

      await page.goto("/login");
      await page.evaluate((t) => {
        localStorage.setItem("multica_token", t);
      }, token);

      await page.goto(`/${workspaceSlug}/agents`);
      await page.waitForURL("**/agents", { timeout: 10000 });

      await expect(page.getByRole("button", { name: "Tasks" })).toBeVisible();
      await page.getByRole("button", { name: "Tasks" }).click();

      await expect(page.getByText("Host Codex Elevation")).toBeVisible();
      await expect(page.getByRole("button", { name: "View Logs" })).toBeVisible();

      await page.getByRole("button", { name: "View Logs" }).click();
      await expect(page.getByText("Host Codex Elevation Logs")).toBeVisible();
      await expect(page.getByText("Last action")).toBeVisible();
    } finally {
      await api.cleanup();
    }
  });
});
