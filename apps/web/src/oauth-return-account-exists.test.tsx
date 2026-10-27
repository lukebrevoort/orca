import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { App, readOAuthReturnStatus } from "./App";

const explanation = "An Orca account already exists for that email address. Sign in with the account or provider you used when you first set up Orca. Nothing in Orca or your mail account changed.";

function withReturn<T>(search: string, check: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { pathname: "/login", search, origin: "http://localhost:5173", href: `http://localhost:5173/login${search}` },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    },
  });
  try {
    return check();
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

for (const provider of ["gmail", "outlook"] as const) {
  test(`account-exists return notice: refusal explained for ${provider}`, () => {
    withReturn(`?provider=${provider}&status=account_exists`, () => {
      const html = renderToStaticMarkup(<App />);
      expect(html).toContain('role="alert"');
      expect(html).toContain("<strong>Sign-in not completed</strong>");
      expect(html).toContain(explanation);
      expect(html).not.toContain("returned an error");
    });
  });

  test(`account-exists return notice: no leak for ${provider}`, () => {
    const params = new URLSearchParams({ provider, status: "account_exists", email: "victim@example.test", reason: "GMAIL_CLIENT_SECRET", message: "do-not-render", intent: "x" });
    withReturn(`?${params}`, () => {
      expect(readOAuthReturnStatus()).toEqual({ provider, kind: "error", reason: "account_exists", intent: null });
      const html = renderToStaticMarkup(<App />);
      expect(html).toContain(explanation);
      expect(html).not.toMatch(/victim@example\.test|GMAIL_CLIENT_SECRET|do-not-render|returned an error/);
      const notice = html.match(/<div class="oauth-notice oauth-notice-error"[^>]*>(.*?)<\/div>/)?.[1];
      expect(notice).toBe(`<strong>Sign-in not completed</strong><span>${explanation}</span>`);
    });
  });

  test(`account-exists return notice: parser refusal explained for ${provider}`, () => {
    withReturn(`?provider=${provider}&status=account_exists`, () => {
      expect(readOAuthReturnStatus()).toEqual({ provider, kind: "error", reason: "account_exists", intent: null });
    });
  });
}

test("account-exists return notice: no leak from markup or huge ignored params", () => {
  const params = new URLSearchParams({ provider: "gmail", status: "account_exists", email: '<img src=x onerror="alert(1)">', reason: "z".repeat(10_000), message: "<script>do-not-render</script>", intent: "unexpected-intent" });
  withReturn(`?${params}`, () => {
    expect(readOAuthReturnStatus()).toEqual({ provider: "gmail", kind: "error", reason: "account_exists", intent: null });
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain(explanation);
    expect(html).not.toMatch(/onerror|do-not-render|unexpected-intent|zzzzzzzz/);
  });
});

for (const query of ["status=account_exists", "provider=&status=account_exists", "provider=invalid&status=account_exists", "provider=%3Cscript%3E&status=account_exists", "provider=gmail&status=", "provider=gmail&status=unexpected"]) {
  test(`account-exists return notice: malformed return ignored (${query})`, () => {
    withReturn(`?${query}`, () => {
      expect(readOAuthReturnStatus()).toBeNull();
      expect(renderToStaticMarkup(<App />)).not.toContain('class="oauth-notice');
    });
  });
}

test("account-exists return notice: unchanged paths for success and existing error", () => {
  withReturn("?provider=gmail&status=success&email=reader@example.test", () => {
    expect(readOAuthReturnStatus()).toEqual({ provider: "gmail", kind: "success", email: "reader@example.test", intent: null });
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('role="status"');
    expect(html).toContain("<strong>Gmail connected</strong>");
    expect(html).toContain("reader@example.test is ready for read-only inbox sync.");
  });
  withReturn("?provider=outlook&status=error&reason=invalid_state", () => {
    expect(readOAuthReturnStatus()).toEqual({ provider: "outlook", kind: "error", reason: "invalid_state", intent: null });
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("<strong>Microsoft Outlook returned an error</strong>");
    expect(html).toContain("The authorization return could not be verified. Nothing in Orca or your mail account changed. Start again from Orca.");
  });
});
