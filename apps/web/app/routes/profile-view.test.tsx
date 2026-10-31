import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { defaultProfile, ProfileSchema, type Profile } from "@veil/features";
import { ProfileView } from "./profile";

const render = (element: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);

const NOW = new Date("2026-10-31T16:00:00.000Z");

const baseProfile = (over: Partial<Profile> = {}): Profile =>
  ProfileSchema.parse({ ...defaultProfile("author-friend", "PixelPal", NOW), ...over });

describe("ProfileView", () => {
  it("renders own profile from local data with bio and display name", () => {
    const html = render(
      <ProfileView
        profile={baseProfile({ bio: "cool by default" })}
        handle="me"
        nickname={null}
        isOwn
        verified={null}
        asOf={null}
        now={NOW}
      />,
    );
    expect(html).toContain("My Profile");
    expect(html).toContain("PixelPal");
    expect(html).toContain("cool by default");
  });

  it("renders a connection profile with verification state and staleness marker", () => {
    const html = render(
      <ProfileView
        profile={baseProfile()}
        handle="friend"
        nickname="Bestie"
        isOwn={false}
        verified
        asOf={new Date("2026-10-30T16:00:00.000Z")}
        now={NOW}
      />,
    );
    expect(html).toContain("Bestie&#x27;s profile");
    expect(html).toContain("Verified from @friend");
    expect(html).toContain("as of");
  });

  it("flags an unsigned connection profile", () => {
    const html = render(
      <ProfileView profile={baseProfile()} handle="friend" nickname={null} isOwn={false} verified={false} asOf={null} now={NOW} />,
    );
    expect(html).toContain("Unsigned - trust the sender");
  });

  it("renders a profile with no decorations and no avatar", () => {
    const html = render(<ProfileView profile={baseProfile()} handle={null} nickname={null} isOwn={false} verified={false} asOf={null} now={NOW} />);
    expect(html).toContain("PixelPal");
    expect(html).not.toContain("<img");
  });

  it("never injects raw SVG markup: inline-svg decorations render through an img data URI", () => {
    const evilSvg = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`;
    const profile = baseProfile({
      decorations: [
        {
          id: "d1",
          kind: "sticker",
          asset: { kind: "inline-svg", data: evilSvg },
          position: { x: 0.5, y: 0.5, z: 1 },
          scale: 1,
          rotation: 0,
        },
      ],
    });
    const html = render(<ProfileView profile={profile} handle={null} nickname={null} isOwn verified={null} asOf={null} now={NOW} />);
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<svg");
  });

  it("renders a data-uri avatar through an img tag", () => {
    const profile = baseProfile({ avatar: { kind: "data-uri", mime: "image/png", data: "aGVsbG8=" } });
    const html = render(<ProfileView profile={profile} handle={null} nickname={null} isOwn verified={null} asOf={null} now={NOW} />);
    expect(html).toContain("data:image/png;base64,aGVsbG8=");
  });
});

describe("profile asset mime validation", () => {
  it("rejects non-image data-uri assets (no HTML/script payloads)", () => {
    const candidate = { ...defaultProfile("author-friend", "PixelPal", NOW), avatar: { kind: "data-uri", mime: "text/html", data: "PHNjcmlwdD4=" } };
    expect(ProfileSchema.safeParse(candidate).success).toBe(false);
  });
});
