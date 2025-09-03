import { createCookieSessionStorage } from "react-router";
import { createThemeSessionResolver } from "remix-themes";

const themeSessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__theme",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secrets: [process.env.THEME_SESSION_SECRET ?? "dev-insecure-theme-secret"],
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365, // 1 year
  },
});

export const themeSessionResolver =
  createThemeSessionResolver(themeSessionStorage);
