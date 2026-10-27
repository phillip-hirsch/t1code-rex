import { describe, expect, it } from "vite-plus/test";

import {
  TUI_SIDEBAR_WIDTH,
  resolveTuiResponsiveLayout,
  toggleSidebarState,
} from "./responsiveLayout.ts";

describe("resolveTuiResponsiveLayout", () => {
  it("keeps the full layout in wide terminals", () => {
    expect(
      resolveTuiResponsiveLayout({
        viewportColumns: 160,
        sidebarCollapsedPreference: false,
      }),
    ).toEqual(
      expect.objectContaining({
        showSidebarToggle: false,
        sidebarForcedCollapsed: false,
        sidebarCollapsed: false,
        sidebarWidth: TUI_SIDEBAR_WIDTH,
        showSidebar: true,
        showWindowDots: true,
        showSidebarAlphaBadge: true,
        sidebarTitle: "tr3x",
        showHeaderProjectBadge: true,
        showComposerModeLabels: true,
        showComposerModelLabel: true,
        showComposerTraitsLabel: true,
        showComposerDividers: true,
      }),
    );
  });

  it("allows manual sidebar collapse before forcing it", () => {
    expect(
      resolveTuiResponsiveLayout({
        viewportColumns: 106,
        sidebarCollapsedPreference: true,
      }),
    ).toEqual(
      expect.objectContaining({
        showSidebarToggle: true,
        sidebarForcedCollapsed: false,
        sidebarCollapsed: true,
        sidebarWidth: 0,
        showSidebar: false,
        showWindowDots: false,
        showSidebarAlphaBadge: false,
        sidebarTitle: "tr3x",
        showHeaderProjectBadge: false,
        showComposerModeLabels: true,
        showComposerModelLabel: true,
        showComposerTraitsLabel: true,
        showComposerDividers: true,
      }),
    );
  });

  it("forces the sidebar closed in very narrow terminals", () => {
    expect(
      resolveTuiResponsiveLayout({
        viewportColumns: 78,
        sidebarCollapsedPreference: false,
      }),
    ).toEqual(
      expect.objectContaining({
        showSidebarToggle: true,
        sidebarForcedCollapsed: true,
        sidebarCollapsed: true,
        sidebarWidth: 0,
        showSidebar: false,
        showWindowDots: false,
        showComposerModeLabels: true,
        showComposerModelLabel: true,
        showComposerTraitsLabel: true,
      }),
    );
  });

  it("keeps the sidebar open at widths that still have room for the full layout", () => {
    expect(
      resolveTuiResponsiveLayout({
        viewportColumns: 86,
        sidebarCollapsedPreference: false,
      }),
    ).toEqual(
      expect.objectContaining({
        showSidebarToggle: true,
        sidebarForcedCollapsed: false,
        sidebarCollapsed: false,
        showSidebar: true,
        showWindowDots: true,
        sidebarTitle: "tr3x",
      }),
    );
  });

  it("keeps the traits label visible while the sidebar is still open", () => {
    expect(
      resolveTuiResponsiveLayout({
        viewportColumns: 110,
        sidebarCollapsedPreference: false,
      }),
    ).toEqual(
      expect.objectContaining({
        showSidebar: true,
        showWindowDots: true,
        sidebarTitle: "tr3x",
        showComposerModeLabels: true,
        showComposerModelLabel: true,
        showComposerTraitsLabel: true,
        showComposerDividers: true,
      }),
    );
  });

  it("collapses the traits label before the other footer labels in tighter widths", () => {
    expect(
      resolveTuiResponsiveLayout({
        viewportColumns: 104,
        sidebarCollapsedPreference: false,
      }),
    ).toEqual(
      expect.objectContaining({
        showSidebar: true,
        showComposerModeLabels: true,
        showComposerModelLabel: true,
        showComposerTraitsLabel: false,
        showComposerDividers: true,
      }),
    );
  });

  it("keeps the sidebar open until the main pane is actually constrained", () => {
    expect(
      resolveTuiResponsiveLayout({
        viewportColumns: 104,
        sidebarCollapsedPreference: false,
      }),
    ).toEqual(
      expect.objectContaining({
        showSidebarToggle: false,
        sidebarForcedCollapsed: false,
        sidebarCollapsed: false,
        showSidebar: true,
        showWindowDots: true,
        sidebarTitle: "tr3x",
      }),
    );
  });
});

describe("toggleSidebarState", () => {
  const press = (
    viewportColumns: number,
    state: { collapsedPreference: boolean; overlayOpen: boolean },
  ) =>
    toggleSidebarState(
      resolveTuiResponsiveLayout({
        viewportColumns,
        sidebarCollapsedPreference: state.collapsedPreference,
      }),
      state,
    );

  it("re-docks after hiding at a narrow width and widening", () => {
    const hidden = press(85, { collapsedPreference: false, overlayOpen: false });
    expect(hidden).toEqual({ collapsedPreference: true, overlayOpen: false, focus: "thread" });

    // Widened to 140, the sidebar is still hidden by the preference; Ctrl+B docks it.
    const layout = resolveTuiResponsiveLayout({
      viewportColumns: 140,
      sidebarCollapsedPreference: true,
    });
    expect(layout.showSidebar).toBe(false);
    const shown = press(140, { collapsedPreference: true, overlayOpen: false });
    expect(shown).toEqual({ collapsedPreference: false, overlayOpen: false, focus: "sidebar" });
    expect(
      resolveTuiResponsiveLayout({ viewportColumns: 140, sidebarCollapsedPreference: false })
        .showSidebar,
    ).toBe(true);
  });

  it("re-docks at the same narrow width it was hidden at", () => {
    expect(press(85, { collapsedPreference: true, overlayOpen: false })).toEqual({
      collapsedPreference: false,
      overlayOpen: false,
      focus: "sidebar",
    });
  });

  it("toggles the overlay only where the sidebar is forced closed", () => {
    const opened = press(70, { collapsedPreference: false, overlayOpen: false });
    expect(opened).toEqual({ collapsedPreference: false, overlayOpen: true, focus: "sidebar" });
    expect(press(70, { collapsedPreference: false, overlayOpen: true })).toEqual({
      collapsedPreference: false,
      overlayOpen: false,
      focus: "thread",
    });
    // A preference set before narrowing survives the overlay toggles.
    expect(press(70, { collapsedPreference: true, overlayOpen: false })?.collapsedPreference).toBe(
      true,
    );
  });

  it("does nothing where the docked sidebar has no toggle", () => {
    expect(press(160, { collapsedPreference: false, overlayOpen: false })).toBeNull();
  });
});
